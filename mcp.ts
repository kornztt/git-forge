// mcp.ts — the Model Context Protocol endpoint at /mcp, JSON-RPC 2.0 over
// Streamable HTTP, revision 2026-07-28.
//
//   server/discover  -> identity, capabilities and supportedVersions in one call
//   initialize       -> the legacy handshake (2025-11-25 and earlier), kept so a
//                       client that predates discover still connects
//   tools/list       -> the six tools, byte-identical across calls
//   tools/call       -> the same Store the REST surface uses, so a repository
//                       or issue created over MCP reads back over /api/v3
//
// Errors: an unknown tool is -32602, a tools/call missing required arguments
// is isError:true, a body that is not JSON is HTTP 400 with -32700, and a call
// without Authorization is HTTP 401. Every request answers inside 3 seconds;
// the handlers here are all in-memory and immediate.

import { StoreError, type Repo, type Store } from './store.ts';

export const MCP_VERSION = '2026-07-28';
export const MCP_SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18'] as const;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * The tool list, built once: tools/list serializes this same value on every
 * call, so two answers are byte-identical.
 */
export const TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'git-forge', version: '1.0.0' };

export interface McpRequest {
  /** The raw request body text (for the parse-error path). */
  rawBody: string;
  /** Authorization header value, or undefined. */
  authorization: string | undefined;
}

export interface McpReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function jsonRpc(id: unknown, result: unknown): McpReply {
  return {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }),
  };
}

function jsonRpcError(status: number, id: unknown, code: number, message: string): McpReply {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function numArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoView(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${store.viewer()}/${repo.name}`,
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: store.viewer(), id: 1000, type: 'User' },
  };
}

function issueView(store: Store, repo: Repo, issue: { number: number; title: string; body: string; state: string; labels: Array<{ name: string; color: string }> }): Record<string, unknown> {
  return {
    id: issue.number,
    node_id: store.issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
  };
}

function pullView(store: Store, repo: Repo, pull: { number: number; title: string; body: string; state: string; headRef: string; baseRef: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null }): Record<string, unknown> {
  return {
    id: pull.number,
    node_id: store.pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: store.headSha(repo, pull) },
    base: { ref: pull.baseRef, sha: store.baseSha(repo, pull) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

/** Resolve a tool call's repository: 404 when the owner is not the viewer or the repo is missing. */
function lookupRepo(store: Store, owner: string, repoName: string): Repo {
  if (!store.ownerMatches(owner)) throw new StoreError(404, 'Not Found');
  const repo = store.getRepo(repoName);
  if (!repo) throw new StoreError(404, 'Not Found');
  return repo;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const missing = (required: string[]): string | null => {
    const absent = required.filter((key) => args[key] === undefined || args[key] === '' || args[key] === null);
    return absent.length > 0 ? `missing required argument(s): ${absent.join(', ')}` : null;
  };
  switch (name) {
    case 'create_repo': {
      const problem = missing(['name']);
      if (problem) return toolError(problem);
      const repoName = strArg(args, 'name');
      try {
        const repo = store.createRepo(repoName, {
          privateFlag: typeof args.private === 'boolean' ? args.private : false,
          description: strArg(args, 'description'),
        });
        return toolResult(repoView(store, repo));
      } catch (err) {
        if (err instanceof StoreError) return toolError(err.message);
        throw err;
      }
    }
    case 'get_repo': {
      const problem = missing(['owner', 'repo']);
      if (problem) return toolError(problem);
      try {
        return toolResult(repoView(store, lookupRepo(store, strArg(args, 'owner'), strArg(args, 'repo'))));
      } catch (err) {
        if (err instanceof StoreError) return toolError(err.message);
        throw err;
      }
    }
    case 'create_issue': {
      const problem = missing(['owner', 'repo', 'title']);
      if (problem) return toolError(problem);
      try {
        const repo = lookupRepo(store, strArg(args, 'owner'), strArg(args, 'repo'));
        const issue = store.createIssue(repo, { title: strArg(args, 'title'), body: strArg(args, 'body') });
        return toolResult(issueView(store, repo, issue));
      } catch (err) {
        if (err instanceof StoreError) return toolError(err.message);
        throw err;
      }
    }
    case 'list_issues': {
      const problem = missing(['owner', 'repo']);
      if (problem) return toolError(problem);
      try {
        const repo = lookupRepo(store, strArg(args, 'owner'), strArg(args, 'repo'));
        const state = strArg(args, 'state') || 'open';
        const issues = store.listIssues(repo, state).map((issue) => issueView(store, repo, issue));
        return toolResult(issues);
      } catch (err) {
        if (err instanceof StoreError) return toolError(err.message);
        throw err;
      }
    }
    case 'create_pull_request': {
      const problem = missing(['owner', 'repo', 'title', 'head', 'base']);
      if (problem) return toolError(problem);
      try {
        const repo = lookupRepo(store, strArg(args, 'owner'), strArg(args, 'repo'));
        const pull = store.createPull(repo, {
          head: strArg(args, 'head'),
          base: strArg(args, 'base'),
          title: strArg(args, 'title'),
          body: strArg(args, 'body'),
        });
        return toolResult(pullView(store, repo, pull));
      } catch (err) {
        if (err instanceof StoreError) return toolError(err.message);
        throw err;
      }
    }
    case 'merge_pull_request': {
      const problem = missing(['owner', 'repo', 'pull_number']);
      if (problem) return toolError(problem);
      const number = numArg(args, 'pull_number');
      if (number === null) return toolError('pull_number must be an integer');
      try {
        const repo = lookupRepo(store, strArg(args, 'owner'), strArg(args, 'repo'));
        const { pull, sha } = store.mergePull(repo, number);
        return toolResult({ ...pullView(store, repo, pull), sha });
      } catch (err) {
        if (err instanceof StoreError) return toolError(err.message);
        throw err;
      }
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export function handleMcp(store: Store, expectedToken: string | null, req: McpRequest): McpReply {
  // Auth is decided before any tool exists: no token, 401.
  const header = req.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return jsonRpcError(401, null, -32001, 'Requires authentication');
  if (expectedToken !== null && match[1] !== expectedToken) return jsonRpcError(401, null, -32001, 'Bad credentials');

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody);
  } catch {
    return jsonRpcError(400, null, -32700, 'Parse error');
  }
  if (!isRecord(parsed)) return jsonRpcError(400, null, -32700, 'Parse error');
  const id = parsed.id ?? null;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};

  // A notification (no id) is answered 202 with no body.
  if (!('id' in parsed)) {
    return { status: 202, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '' };
  }

  if (method === 'server/discover') {
    return jsonRpc(id, {
      supportedVersions: [...MCP_SUPPORTED],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = (MCP_SUPPORTED as readonly string[]).includes(offered) ? offered : '2025-11-25';
    return jsonRpc(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'tools/list') {
    return jsonRpc(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((entry) => entry.name === name);
    if (!tool) return jsonRpcError(200, id, -32602, `Unknown tool: ${name}`);
    return jsonRpc(id, callTool(store, name, args));
  }

  if (method === 'ping') {
    return jsonRpc(id, {});
  }

  return jsonRpcError(200, id, -32601, `Method not found: ${method}`);
}
