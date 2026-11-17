// graphql.ts — a small GraphQL v4 executor for the documents gh and
// github-mcp-server actually send.
//
// A hand-rolled parser for the subset those documents use: operations with
// variable definitions, fields with aliases and arguments, inline fragments,
// and values (variables, strings, ints, booleans, null, enums, input objects,
// lists). The executor resolves against the same Store the REST surface uses,
// so a mutation over GraphQL reads back over REST.
//
// Introspection covers the types the suite probes: Issue, PullRequest,
// Repository (fields) and SearchType (enum values), plus the enums the
// documents name. An unknown field is a 200 with an errors array naming it;
// an unknown repository is data.repository = null with no errors.

import { StoreError, decodeGlobalId, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.]/.test(source[j]!)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlField {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selection: GqlField[] | null;
  fragmentType: string | null;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: GqlField[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const next = this.peek();
    if (next?.kind === 'name') name = this.next().value;
    const variables: string[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        variables.push(this.expectName());
        this.expectPunct(':');
        this.parseType();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): GqlField {
    const token = this.next();
    if (token.kind === 'spread') {
      // ... on Type { ... }
      const on = this.next();
      if (on.kind !== 'name' || on.value !== 'on') throw new Error('only inline fragments (... on Type) are supported');
      const type = this.expectName();
      const selection = this.parseSelectionSet();
      return { alias: null, name: '', args: [], selection, fragmentType: type };
    }
    if (token.kind !== 'name') throw new Error('expected a field name in GraphQL document');
    let alias: string | null = null;
    let name = token.value;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@...) are not used by the suite's documents; skip any.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
    let selection: GqlField[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection, fragmentType: null };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

/** Resolve a parsed value against the operation's variables. */
function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argMap(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// introspection data
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private', 'isPrivate', 'url', 'createdAt'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

type Obj =
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; number: number }
  | { __type: 'PullRequest'; repo: Repo; number: number }
  | { __type: 'IssueConnection'; repo: Repo; issues: Array<{ number: number }>; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __type: 'PullRequestChangedFileConnection'; files: Array<{ path: string }> }
  | { __type: 'PullRequestChangedFile'; path: string }
  | { __type: 'Ref'; name: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'Type'; name: string }
  | { __type: 'Field'; name: string }
  | { __type: 'EnumValue'; name: string }
  | { __type: 'Comment'; repo: Repo; id: number; body: string }
  | { __type: 'CommentEdge'; repo: Repo; id: number; body: string };

function cursorForIssue(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function issueNumberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

class Executor {
  private errors: Array<{ message: string }> = [];

  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  run(operation: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: Array<{ message: string }> } {
    this.errors = [];
    const data: Record<string, unknown> = {};
    for (const field of operation.selection) {
      const key = field.alias ?? field.name;
      if (field.fragmentType !== null) continue;
      data[key] = this.resolveRoot(operation.kind, field, variables);
    }
    return { data, errors: this.errors };
  }

  private err(message: string): void {
    this.errors.push({ message });
  }

  private resolveRoot(kind: 'query' | 'mutation', field: GqlField, variables: Record<string, unknown>): unknown {
    const args = argMap(field, variables);
    if (kind === 'query') {
      if (field.name === 'viewer') {
        return this.resolveFields({ __type: 'User', login: this.store.viewer() }, field.selection ?? [], variables);
      }
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (!this.store.ownerMatches(owner)) return null;
        const repo = this.store.getRepo(name);
        if (!repo) return null;
        return this.resolveFields({ __type: 'Repository', repo }, field.selection ?? [], variables);
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'repo') {
          const repo = this.store.getRepo(decoded.repo);
          if (!repo) return null;
          return this.resolveFields({ __type: 'Repository', repo }, field.selection ?? [], variables);
        }
        if (decoded.kind === 'issue') {
          const repo = this.store.getRepo(decoded.repo);
          const issue = repo?.issues.get(decoded.number);
          if (!repo || !issue) return null;
          return this.resolveFields({ __type: 'Issue', repo, number: decoded.number }, field.selection ?? [], variables);
        }
        if (decoded.kind === 'pr') {
          const repo = this.store.getRepo(decoded.repo);
          const pull = repo?.pulls.get(decoded.number);
          if (!repo || !pull) return null;
          return this.resolveFields({ __type: 'PullRequest', repo, number: decoded.number }, field.selection ?? [], variables);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (!(name in TYPE_FIELDS) && !(name in ENUM_VALUES)) return null;
        return this.resolveFields({ __type: 'Type', name }, field.selection ?? [], variables);
      }
      this.err(`Cannot query field "${field.name}" on type "Query".`);
      return null;
    }
    // mutations
    try {
      if (field.name === 'createIssue') return this.mutationCreateIssue(field, args, variables);
      if (field.name === 'closeIssue') return this.mutationCloseIssue(field, args, variables);
      if (field.name === 'createPullRequest') return this.mutationCreatePullRequest(field, args, variables);
      if (field.name === 'mergePullRequest') return this.mutationMergePullRequest(field, args, variables);
      if (field.name === 'addComment') return this.mutationAddComment(field, args, variables);
    } catch (err) {
      if (err instanceof StoreError) {
        this.err(err.message);
        return null;
      }
      throw err;
    }
    this.err(`Cannot query field "${field.name}" on type "Mutation".`);
    return null;
  }

  private resolveFields(obj: Obj, selection: GqlField[], variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of selection) {
      const key = field.alias ?? field.name;
      if (field.fragmentType !== null) {
        if (field.fragmentType === obj.__type) {
          Object.assign(out, this.resolveFields(obj, field.selection ?? [], variables));
        }
        continue;
      }
      out[key] = this.resolveField(obj, field, variables);
    }
    return out;
  }

  private resolveField(obj: Obj, field: GqlField, variables: Record<string, unknown>): unknown {
    const args = argMap(field, variables);
    const sub = field.selection ?? [];
    switch (obj.__type) {
      case 'User': {
        if (field.name === 'login') return obj.login;
        if (field.name === 'id') return this.store.viewer();
        break;
      }
      case 'Repository': {
        const repo = obj.repo;
        switch (field.name) {
          case 'id':
            return this.store.repoGlobalId(repo);
          case 'databaseId':
            return repo.dbId;
          case 'name':
            return repo.name;
          case 'nameWithOwner':
            return `${this.store.viewer()}/${repo.name}`;
          case 'owner':
            return this.resolveFields({ __type: 'User', login: this.store.viewer() }, sub, variables);
          case 'defaultBranchRef': {
            const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
            if (tip === undefined) return null;
            return this.resolveFields({ __type: 'Ref', name: repo.defaultBranch }, sub, variables);
          }
          case 'viewerPermission':
            return 'ADMIN';
          case 'hasIssuesEnabled':
            return true;
          case 'description':
            return repo.description;
          case 'private':
          case 'isPrivate':
            return repo.privateFlag;
          case 'issue': {
            const issue = repo.issues.get(Number(args.number));
            if (!issue) return null;
            return this.resolveFields({ __type: 'Issue', repo, number: issue.number }, sub, variables);
          }
          case 'issues':
            return this.resolveFields(this.issuesConnection(repo, args), sub, variables);
          case 'pullRequest': {
            const pull = repo.pulls.get(Number(args.number));
            if (!pull) return null;
            return this.resolveFields({ __type: 'PullRequest', repo, number: pull.number }, sub, variables);
          }
          case 'pullRequests':
            return this.resolveFields(this.pullsConnection(repo, args), sub, variables);
        }
        break;
      }
      case 'Issue': {
        const issue = obj.repo.issues.get(obj.number);
        if (!issue) return null;
        switch (field.name) {
          case 'id':
            return this.store.issueGlobalId(obj.repo, obj.number);
          case 'number':
            return issue.number;
          case 'title':
            return issue.title;
          case 'body':
            return issue.body;
          case 'state':
            return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        }
        break;
      }
      case 'PullRequest': {
        const pull = obj.repo.pulls.get(obj.number);
        if (!pull) return null;
        switch (field.name) {
          case 'id':
            return this.store.pullGlobalId(obj.repo, obj.number);
          case 'number':
            return pull.number;
          case 'title':
            return pull.title;
          case 'body':
            return pull.body;
          case 'state':
            return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
          case 'merged':
            return pull.merged;
          case 'mergeable':
            return this.store.mergeable(obj.repo, pull);
          case 'headRefName':
            return pull.headRef;
          case 'baseRefName':
            return pull.baseRef;
          case 'headRefOid':
            return this.store.headSha(obj.repo, pull);
          case 'baseRefOid':
            return this.store.baseSha(obj.repo, pull);
          case 'files': {
            const files = this.store.pullFiles(obj.repo, pull).map((file) => ({ path: file.filename }));
            const first = typeof args.first === 'number' ? args.first : files.length;
            return this.resolveFields(
              { __type: 'PullRequestChangedFileConnection', files: files.slice(0, first) },
              sub,
              variables,
            );
          }
        }
        break;
      }
      case 'IssueConnection': {
        switch (field.name) {
          case 'nodes':
            return obj.issues.map((entry) => this.resolveFields({ __type: 'Issue', repo: obj.repo, number: entry.number }, sub, variables));
          case 'pageInfo':
            return this.resolveFields({ __type: 'PageInfo', hasNextPage: obj.hasNextPage, endCursor: obj.endCursor }, sub, variables);
          case 'totalCount':
            return obj.issues.length;
        }
        break;
      }
      case 'PullRequestConnection': {
        switch (field.name) {
          case 'nodes':
            return obj.pulls.map((pull) => this.resolveFields({ __type: 'PullRequest', repo: obj.repo, number: pull.number }, sub, variables));
          case 'pageInfo':
            return this.resolveFields({ __type: 'PageInfo', hasNextPage: false, endCursor: null }, sub, variables);
          case 'totalCount':
            return obj.pulls.length;
        }
        break;
      }
      case 'PullRequestChangedFileConnection': {
        switch (field.name) {
          case 'nodes':
            return obj.files.map((file) => this.resolveFields({ __type: 'PullRequestChangedFile', path: file.path }, sub, variables));
          case 'pageInfo':
            return this.resolveFields({ __type: 'PageInfo', hasNextPage: false, endCursor: null }, sub, variables);
          case 'totalCount':
            return obj.files.length;
        }
        break;
      }
      case 'PullRequestChangedFile': {
        if (field.name === 'path') return obj.path;
        break;
      }
      case 'Ref': {
        if (field.name === 'name') return obj.name;
        break;
      }
      case 'PageInfo': {
        if (field.name === 'hasNextPage') return obj.hasNextPage;
        if (field.name === 'endCursor') return obj.endCursor;
        if (field.name === 'hasPreviousPage') return false;
        if (field.name === 'startCursor') return null;
        break;
      }
      case 'Type': {
        if (field.name === 'name') return obj.name;
        if (field.name === 'kind') return obj.name in ENUM_VALUES ? 'ENUM' : 'OBJECT';
        if (field.name === 'fields') {
          const names = TYPE_FIELDS[obj.name] ?? [];
          return names.map((name) => this.resolveFields({ __type: 'Field', name }, sub, variables));
        }
        if (field.name === 'enumValues') {
          const names = ENUM_VALUES[obj.name] ?? [];
          return names.map((name) => this.resolveFields({ __type: 'EnumValue', name }, sub, variables));
        }
        break;
      }
      case 'Field':
      case 'EnumValue': {
        if (field.name === 'name') return obj.name;
        break;
      }
      case 'Comment': {
        if (field.name === 'id') return this.store.commentGlobalId(obj.repo, obj.id);
        if (field.name === 'body') return obj.body;
        break;
      }
      case 'CommentEdge': {
        if (field.name === 'node') return this.resolveFields({ __type: 'Comment', repo: obj.repo, id: obj.id, body: obj.body }, sub, variables);
        if (field.name === 'cursor') return null;
        break;
      }
    }
    this.err(`Cannot query field "${field.name}" on type "${obj.__type}".`);
    return null;
  }

  private issuesConnection(repo: Repo, args: Record<string, unknown>): Obj {
    let issues = repo.issueOrder.map((number) => repo.issues.get(number)!).filter(Boolean);
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state)));
      issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
    }
    const orderBy = args.orderBy;
    if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
      const order = orderBy as Record<string, unknown>;
      const direction = String(order.direction ?? 'ASC');
      // CREATED_AT order is creation order (the number); ties by number.
      issues = [...issues].sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
    }
    // Cursor paging: skip through the item the cursor names.
    let start = 0;
    if (typeof args.after === 'string' && args.after !== '') {
      const number = issueNumberFromCursor(args.after);
      if (number !== null) {
        const index = issues.findIndex((issue) => issue.number === number);
        if (index >= 0) start = index + 1;
      }
    }
    const first = typeof args.first === 'number' ? args.first : issues.length;
    const page = issues.slice(start, start + first);
    const hasNextPage = start + page.length < issues.length;
    const endCursor = page.length > 0 ? cursorForIssue(page[page.length - 1]!.number) : null;
    return { __type: 'IssueConnection', repo, issues: page, hasNextPage, endCursor };
  }

  private pullsConnection(repo: Repo, args: Record<string, unknown>): Obj {
    let pulls = repo.pullOrder.map((number) => repo.pulls.get(number)!).filter(Boolean);
    pulls = pulls.filter((pull) => pull.state === 'open');
    const first = typeof args.first === 'number' ? args.first : pulls.length;
    return { __type: 'PullRequestConnection', repo, pulls: pulls.slice(0, first) };
  }

  // -- mutations ---------------------------------------------------------------

  private repoFromGlobalId(id: string): Repo {
    const decoded = decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'repo') throw new StoreError(422, 'Unknown repository id');
    const repo = this.store.getRepo(decoded.repo);
    if (!repo) throw new StoreError(404, 'Repository not found');
    return repo;
  }

  private mutationCreateIssue(field: GqlField, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = this.repoFromGlobalId(String(input.repositoryId ?? ''));
    const issue = this.store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
    const result: Record<string, unknown> = {};
    for (const subField of field.selection ?? []) {
      if (subField.name === 'issue') {
        result[subField.alias ?? 'issue'] = this.resolveFields({ __type: 'Issue', repo, number: issue.number }, subField.selection ?? [], variables);
      }
    }
    return result;
  }

  private mutationCloseIssue(field: GqlField, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (!decoded || decoded.kind !== 'issue') throw new StoreError(422, 'Unknown issue id');
    const repo = this.store.getRepo(decoded.repo);
    if (!repo) throw new StoreError(404, 'Repository not found');
    const issue = this.store.patchIssue(repo, decoded.number, { state: 'closed' });
    const result: Record<string, unknown> = {};
    for (const subField of field.selection ?? []) {
      if (subField.name === 'issue') {
        result[subField.alias ?? 'issue'] = this.resolveFields({ __type: 'Issue', repo, number: issue.number }, subField.selection ?? [], variables);
      }
    }
    return result;
  }

  private mutationCreatePullRequest(field: GqlField, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = this.repoFromGlobalId(String(input.repositoryId ?? ''));
    const pull = this.store.createPull(repo, {
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
      title: String(input.title ?? ''),
      body: '',
    });
    const result: Record<string, unknown> = {};
    for (const subField of field.selection ?? []) {
      if (subField.name === 'pullRequest') {
        result[subField.alias ?? 'pullRequest'] = this.resolveFields({ __type: 'PullRequest', repo, number: pull.number }, subField.selection ?? [], variables);
      }
    }
    return result;
  }

  private mutationMergePullRequest(field: GqlField, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (!decoded || decoded.kind !== 'pr') throw new StoreError(422, 'Unknown pull request id');
    const repo = this.store.getRepo(decoded.repo);
    if (!repo) throw new StoreError(404, 'Repository not found');
    this.store.mergePull(repo, decoded.number);
    const result: Record<string, unknown> = {};
    for (const subField of field.selection ?? []) {
      if (subField.name === 'pullRequest') {
        result[subField.alias ?? 'pullRequest'] = this.resolveFields({ __type: 'PullRequest', repo, number: decoded.number }, subField.selection ?? [], variables);
      }
    }
    return result;
  }

  private mutationAddComment(field: GqlField, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (!decoded || decoded.kind !== 'issue') throw new StoreError(422, 'Unknown subject id');
    const repo = this.store.getRepo(decoded.repo);
    if (!repo) throw new StoreError(404, 'Repository not found');
    const comment = this.store.addComment(repo, decoded.number, String(input.body ?? ''));
    const result: Record<string, unknown> = {};
    for (const subField of field.selection ?? []) {
      if (subField.name === 'commentEdge') {
        result[subField.alias ?? 'commentEdge'] = this.resolveFields(
          { __type: 'CommentEdge', repo, id: comment.id, body: comment.body },
          subField.selection ?? [],
          variables,
        );
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GraphqlRequest {
  body: unknown;
  bodyMalformed: boolean;
}

export function handleGraphql(store: Store, req: GraphqlRequest): { status: number; body: string } {
  if (req.bodyMalformed) {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Malformed JSON body' }] }) };
  }
  const operations = Array.isArray(req.body) ? req.body : [req.body];
  const results: unknown[] = [];
  for (const entry of operations) {
    if (entry === null || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).query !== 'string') {
      results.push({ data: null, errors: [{ message: 'A GraphQL operation needs a query string' }] });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    try {
      const parsed = new Parser(tokenize(record.query as string)).parseDocument();
      const operation = parsed[0];
      if (!operation) {
        results.push({ data: null, errors: [{ message: 'Empty GraphQL document' }] });
        continue;
      }
      const executor = new Executor(store);
      results.push(executor.run(operation, variables));
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    }
  }
  const body = Array.isArray(req.body) ? results : results[0];
  return { status: 200, body: JSON.stringify(body) };
}
