// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// Repositories, branches, commits and contents; issues, comments and labels;
// pull requests, their files and merges. Every reply is application/json with
// a non-empty X-GitHub-Request-Id; errors are JSON {"message": ...}.
// One bearer token (MAKEFUN_SHOP_TOKEN) is the viewer's: a request without it
// is 401, and a repository under another owner is 404, never 403.

import { parseCommit } from './gitutil.ts';
import {
  FORGE_DATE,
  StoreError,
  buildTreeFromFiles,
  filesAtCommit,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments (no leading empty segment). */
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** The request's origin, for absolute pagination links. */
  baseUrl: string;
  /** The parsed JSON body, when the request carried one. */
  body: unknown;
  /** True when a carried body failed to parse as JSON. */
  bodyMalformed: boolean;
}

export interface RestReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_CT = 'application/json; charset=utf-8';

function reply(status: number, value: unknown, headers: Record<string, string> = {}): RestReply {
  return { status, headers: { 'content-type': JSON_CT, ...headers }, body: `${JSON.stringify(value)}\n` };
}

function noContent(headers: Record<string, string> = {}): RestReply {
  return { status: 204, headers: { 'content-type': JSON_CT, ...headers }, body: '' };
}

function error(status: number, message: string): RestReply {
  return reply(status, { message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strField(body: unknown, field: string): string {
  if (!isRecord(body)) return '';
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function boolField(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${store.viewer()}/${repo.name}`,
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: store.viewer(), id: 1000, type: 'User' },
    html_url: `https://example.invalid/${store.viewer()}/${repo.name}`,
    created_at: FORGE_DATE,
    updated_at: FORGE_DATE,
    has_issues: true,
    has_pull_requests: true,
    fork: false,
    archived: false,
    disabled: false,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    node_id: store.issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label: Label) => ({ name: label.name, color: label.color })),
    user: { login: store.viewer(), id: 1000, type: 'User' },
    created_at: FORGE_DATE,
    updated_at: FORGE_DATE,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

function commentJson(store: Store, repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: store.commentGlobalId(repo, comment.id),
    body: comment.body,
    user: { login: store.viewer(), id: 1000, type: 'User' },
    created_at: FORGE_DATE,
    updated_at: FORGE_DATE,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.number,
    node_id: store.pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: store.headSha(repo, pull), label: `${store.viewer()}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: store.baseSha(repo, pull), label: `${store.viewer()}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? store.mergeable(repo, pull) === 'MERGEABLE' : null,
    user: { login: store.viewer(), id: 1000, type: 'User' },
    created_at: FORGE_DATE,
    updated_at: FORGE_DATE,
  };
}

/** "Name <email> 1700000000 +0000" -> {name, email, date}. */
function personOf(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: FORGE_DATE };
  const epoch = Number(match[3]);
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(epoch * 1000).toISOString() };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return { sha };
  const commit = parseCommit(object.data);
  return {
    sha,
    commit: {
      // GitHub's API reports the message without the trailing newline the
      // object stores; a message the fixture wrote verbatim reads back exact.
      message: commit.message.replace(/\n+$/, ''),
      author: personOf(commit.author),
      committer: personOf(commit.committer),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

export interface RestAuth {
  /** The expected bearer token; null accepts any non-empty bearer token. */
  expectedToken: string | null;
}

export function handleRest(store: Store, auth: RestAuth, req: RestRequest): RestReply {
  const requestId = store.nextRequestId();
  const withId = (rep: RestReply): RestReply => ({
    ...rep,
    headers: { 'x-github-request-id': requestId, ...rep.headers },
  });
  try {
    return withId(route(store, auth, req));
  } catch (err) {
    if (err instanceof StoreError) return withId(error(err.status, err.message));
    return withId(error(500, err instanceof Error ? err.message : String(err)));
  }
}

function requireAuth(auth: RestAuth, req: RestRequest): void {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) throw new StoreError(401, 'Requires authentication');
  if (auth.expectedToken !== null && match[1] !== auth.expectedToken) {
    throw new StoreError(401, 'Bad credentials');
  }
}

function route(store: Store, auth: RestAuth, req: RestRequest): RestReply {
  const seg = req.segments;
  const method = req.method;

  // The API root and meta are public; everything else needs the bearer token.
  if (method === 'GET' && seg.length === 2 && seg[0] === 'api' && seg[1] === 'v3') {
    return reply(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (method === 'GET' && seg.length === 3 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'meta') {
    return reply(200, { installed_version: '1.0.0' });
  }
  if (seg.length < 2 || seg[0] !== 'api' || seg[1] !== 'v3') return error(404, 'Not Found');

  requireAuth(auth, req);
  if (req.bodyMalformed) throw new StoreError(400, 'Malformed JSON body');

  // GET /api/v3/user
  if (method === 'GET' && seg.length === 3 && seg[2] === 'user') {
    return reply(200, { login: store.viewer(), id: 1000, type: 'User', name: store.viewer() });
  }

  // /api/v3/user/repos
  if (seg.length === 4 && seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'GET') return listUserRepos(store, req);
    if (method === 'POST') {
      const name = strField(req.body, 'name');
      const repo = store.createRepo(name, {
        privateFlag: boolField(req.body, 'private', false),
        description: strField(req.body, 'description'),
      });
      return reply(201, repoJson(store, repo));
    }
    return error(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg.length >= 4 && seg[2] === 'repos') {
    return routeRepo(store, req, seg[3]!, seg[4]!);
  }

  return error(404, 'Not Found');
}

function listUserRepos(store: Store, req: RestRequest): RestReply {
  const perPage = clampInt(Number(req.query.get('per_page') ?? '30'), 1, 100, 30);
  const page = clampInt(Number(req.query.get('page') ?? '1'), 1, 1_000_000, 1);
  const all = store.listRepos();
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const next = `${req.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    headers.link = `<${next}>; rel="next"`;
  }
  return reply(
    200,
    slice.map((repo) => repoJson(store, repo)),
    headers,
  );
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Resolve /repos/{owner}/{name}: 404 when the owner is not the viewer or the repo is missing. */
function lookupRepo(store: Store, owner: string, name: string): Repo {
  if (!store.ownerMatches(owner)) throw new StoreError(404, 'Not Found');
  const repo = store.getRepo(name);
  if (!repo) throw new StoreError(404, 'Not Found');
  return repo;
}

function routeRepo(store: Store, req: RestRequest, owner: string, name: string): RestReply {
  const method = req.method;
  // Segments are [api, v3, repos, owner, name, ...sub]; the sub-path starts at 5.
  const rest = req.segments.slice(5);
  const repo = lookupRepo(store, owner, name);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return reply(200, repoJson(store, repo));
    if (method === 'PATCH') {
      const description = strField(req.body, 'description');
      if (isRecord(req.body) && 'description' in req.body) repo.description = description;
      return reply(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(name);
      return noContent();
    }
    return error(404, 'Not Found');
  }

  const head = rest[0]!;

  // branches
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`)! }, protected: false }));
      return reply(200, branches);
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return error(404, 'Not Found');
      return reply(200, { name: branch, commit: { sha }, protected: false });
    }
    return error(404, 'Not Found');
  }

  // git data: refs
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = strField(req.body, 'ref');
      const sha = strField(req.body, 'sha');
      store.createRef(repo, ref, sha);
      return reply(201, { ref, object: { sha } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      const sha = repo.refs.get(full);
      if (sha === undefined) return error(404, 'Not Found');
      return reply(200, { ref: full, object: { sha } });
    }
    return error(404, 'Not Found');
  }

  // commits
  if (head === 'commits' && method === 'GET' && rest.length === 1) {
    const ref = req.query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (tip === undefined) return error(404, 'Not Found');
    const commits = store.commitsFrom(repo, tip).map((sha) => commitJson(repo, sha));
    return reply(200, commits);
  }

  // contents
  if (head === 'contents') {
    return routeContents(store, repo, req, rest.slice(1).join('/'));
  }

  // labels
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const name = strField(req.body, 'name');
      if (name === '') return error(422, 'Label name is required');
      const label = store.createLabel(repo, name, strField(req.body, 'color') || undefined);
      return reply(201, { name: label.name, color: label.color });
    }
    if (method === 'GET' && rest.length === 1) {
      return reply(
        200,
        [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })),
      );
    }
    return error(404, 'Not Found');
  }

  // issues
  if (head === 'issues') {
    return routeIssues(store, repo, req, rest.slice(1));
  }

  // pulls
  if (head === 'pulls') {
    return routePulls(store, repo, req, rest.slice(1));
  }

  return error(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function routeContents(store: Store, repo: Repo, req: RestRequest, path: string): RestReply {
  const method = req.method;
  const branch = strField(req.body, 'branch') || req.query.get('ref') || repo.defaultBranch;

  if (method === 'GET') {
    const refName = req.query.get('ref') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, refName);
    if (tip === undefined) return error(404, 'Not Found');
    const files = filesAtCommitFor(repo, tip);
    if (files.has(path)) {
      const sha = files.get(path)!;
      const object = repo.objects.get(sha)!;
      return reply(200, {
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
        sha,
        size: object.data.length,
        name: path.split('/').pop() ?? path,
        path,
      });
    }
    // A directory: the immediate children of the path prefix.
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size?: number }>();
    for (const [filePath, sha] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const object = repo.objects.get(sha)!;
        children.set(rest, { type: 'file', name: rest, path: filePath, sha, size: object.data.length });
      } else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) {
          children.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, sha: shaOfTree(repo, tip, `${prefix}${dir}`) });
        }
      }
    }
    if (children.size === 0) return error(404, 'Not Found');
    return reply(
      200,
      [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    );
  }

  if (method === 'PUT') {
    const contentB64 = strField(req.body, 'content');
    if (contentB64 === '') return error(422, 'Content is required');
    const content = Buffer.from(contentB64, 'base64');
    const message = strField(req.body, 'message') || `Update ${path}`;
    const sha = isRecord(req.body) && typeof req.body.sha === 'string' ? req.body.sha : undefined;
    const result = store.putFile(repo, branch, path, content, message, sha);
    return reply(result.created ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: result.blobSha, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: result.commitSha, message },
    });
  }

  if (method === 'DELETE') {
    const message = strField(req.body, 'message') || `Delete ${path}`;
    const sha = isRecord(req.body) && typeof req.body.sha === 'string' ? req.body.sha : undefined;
    const result = store.deleteFile(repo, branch, path, message, sha);
    return reply(200, { commit: { sha: result.commitSha, message } });
  }

  return error(404, 'Not Found');
}

function filesAtCommitFor(repo: Repo, tip: string): Map<string, string> {
  return filesAtCommit(repo, tip);
}

/** The tree oid of a directory path at a commit (the empty tree when unknown). */
function shaOfTree(repo: Repo, tip: string, dirPath: string): string {
  const files = filesAtCommitFor(repo, tip);
  const prefix = `${dirPath}/`;
  const sub = new Map<string, string>();
  for (const [path, sha] of files) {
    if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), sha);
  }
  return buildTreeFromFiles(repo, sub);
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function routeIssues(store: Store, repo: Repo, req: RestRequest, rest: string[]): RestReply {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'POST') {
      const labels = isRecord(req.body) && Array.isArray(req.body.labels) ? (req.body.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      const issue = store.createIssue(repo, { title: strField(req.body, 'title'), body: strField(req.body, 'body'), labels });
      return reply(201, issueJson(store, repo, issue));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      const perPage = clampInt(Number(req.query.get('per_page') ?? '30'), 1, 1000, 30);
      let issues = store.listIssues(repo, state);
      if (sort === 'created') {
        issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      return reply(
        200,
        issues.slice(0, perPage).map((issue) => issueJson(store, repo, issue)),
      );
    }
    return error(404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return error(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') {
      const issue = store.getIssue(repo, number);
      if (!issue) return error(404, 'Not Found');
      return reply(200, issueJson(store, repo, issue));
    }
    if (method === 'PATCH') {
      const issue = store.patchIssue(repo, number, {
        state: isRecord(req.body) && typeof req.body.state === 'string' ? req.body.state : undefined,
        title: isRecord(req.body) && typeof req.body.title === 'string' ? req.body.title : undefined,
        body: isRecord(req.body) && typeof req.body.body === 'string' ? req.body.body : undefined,
      });
      return reply(200, issueJson(store, repo, issue));
    }
    return error(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const comment = store.addComment(repo, number, strField(req.body, 'body'));
      return reply(201, commentJson(store, repo, comment));
    }
    if (method === 'GET') {
      const comments = store.listComments(repo, number);
      return reply(
        200,
        comments.map((comment) => commentJson(store, repo, comment)),
      );
    }
    return error(404, 'Not Found');
  }

  return error(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------

function routePulls(store: Store, repo: Repo, req: RestRequest, rest: string[]): RestReply {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'POST') {
      const pull = store.createPull(repo, {
        head: strField(req.body, 'head'),
        base: strField(req.body, 'base'),
        title: strField(req.body, 'title'),
        body: strField(req.body, 'body'),
      });
      return reply(201, pullJson(store, repo, pull));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const perPage = clampInt(Number(req.query.get('per_page') ?? '30'), 1, 1000, 30);
      const pulls = store.listPulls(repo, state);
      return reply(
        200,
        pulls.slice(0, perPage).map((pull) => pullJson(store, repo, pull)),
      );
    }
    return error(404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return error(404, 'Not Found');

  if (rest.length === 1 && method === 'GET') {
    const pull = store.getPull(repo, number);
    if (!pull) return error(404, 'Not Found');
    return reply(200, pullJson(store, repo, pull));
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const pull = store.getPull(repo, number);
    if (!pull) return error(404, 'Not Found');
    return reply(200, store.pullFiles(repo, pull));
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const { pull, sha } = store.mergePull(repo, number);
    return reply(200, { merged: true, sha, message: `Merged pull request #${pull.number}` });
  }

  return error(404, 'Not Found');
}
