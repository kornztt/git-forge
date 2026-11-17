// store.ts — the forge's whole state, in memory, deterministic.
//
// One Store holds every repository. A repository holds its git objects (a Map
// from oid to {type, data}), its refs, and its REST resources (issues, labels,
// comments, pull requests), all on the same objects the git surface serves, so
// a commit made over REST clones over git and a push over git reads back over
// REST.
//
// Determinism rules, kept here so no handler can break them:
//   - server-created commits carry one fixed identity and one fixed timestamp
//     (1700000000, +0000); the client builds its own commits with its own bytes
//     and the store keeps them byte-exactly.
//   - global (Relay) ids are base64url of a stable key, never a plain number.
//   - no Date.now(), no Math.random() anywhere in this file.

import {
  ZERO_OID,
  buildTree,
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type GitObj,
  type TreeEntry,
} from './gitutil.ts';

/** The identity every commit the server itself creates carries. */
export const FORGE_IDENTITY = 'Git Forge <forge@make.fun>';
/** The Unix timestamp every server-created commit carries. Never a wall clock. */
export const FORGE_EPOCH = 1_700_000_000;
/** The ISO timestamp string the REST/GraphQL views use for merged/created times. */
export const FORGE_DATE = '2025-01-01T00:00:00Z';
/** The viewer login of the kit's fixed scenario seed, used before any owner is seen. */
export const DEFAULT_VIEWER = 'adaiversen';

/** Build a commit object's bytes with the forge's fixed identity and timestamp. */
export function buildServerCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const body = message.endsWith('\n') ? message : `${message}\n`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${FORGE_IDENTITY} ${FORGE_EPOCH} +0000`, `committer ${FORGE_IDENTITY} ${FORGE_EPOCH} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8');
}

/** base64url of a stable key: the opaque global id for a repository, issue, PR or comment. */
export function globalId(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; repo: string; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0]!;
    const repo = parts[1]!;
    const number = parts.length > 2 ? Number(parts[2]) : 0;
    if (kind !== 'repo' && kind !== 'issue' && kind !== 'pr' && kind !== 'comment') return null;
    if (repo === '') return null;
    return { kind, repo, number };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// file maps and trees
// ---------------------------------------------------------------------------

/** Build (and store) the tree objects for a flat path -> blob-oid map. */
export function buildTreeFromFiles(repo: Repo, files: ReadonlyMap<string, string>): string {
  const build = (paths: ReadonlyMap<string, string>): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, string>>();
    for (const [path, oid] of paths) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: '100644', name: path, oid });
      } else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        let sub = dirs.get(dir);
        if (!sub) {
          sub = new Map();
          dirs.set(dir, sub);
        }
        sub.set(rest, oid);
      }
    }
    for (const [name, sub] of dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(files);
}

/** The flat path -> blob-oid map of a tree object. */
export function readFilesFromTree(repo: Repo, treeOid: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else if (entry.mode !== '160000') files.set(`${prefix}${entry.name}`, entry.oid);
    }
  };
  walk(treeOid, '');
  return files;
}

/** The flat path -> blob-oid map of a commit's tree (empty map when the commit is unknown). */
export function filesAtCommit(repo: Repo, commitOid: string): Map<string, string> {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return new Map();
  return readFilesFromTree(repo, parseCommit(object.data).tree);
}

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
}

export interface Comment {
  readonly id: number;
  readonly issueNumber: number;
  body: string;
}

export interface Pull {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  readonly name: string;
  readonly dbId: number;
  readonly createdSeq: number;
  privateFlag: boolean;
  description: string;
  readonly defaultBranch: string;
  /** oid -> object. */
  readonly objects: Map<string, GitObj>;
  /** full refname -> oid. */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  issueOrder: number[];
  issueSeq: number;
  readonly pulls: Map<number, Pull>;
  pullOrder: number[];
  pullSeq: number;
  readonly comments: Map<number, Comment[]>;
  commentSeq: number;
}

export class StoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The whole forge: repositories, the pinned token owner, and the request counter. */
export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private dbIdSeq = 0;
  private requestSeq = 0;
  /** The login the bearer token names, pinned from the first owner seen in a URL. */
  viewerLogin: string | null = null;

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  /** The token owner's login: pinned when known, else the fixed-seed viewer. */
  viewer(): string {
    return this.viewerLogin ?? DEFAULT_VIEWER;
  }

  /** Pin the viewer login from an owner seen in a request path; true when it matches. */
  ownerMatches(owner: string): boolean {
    if (this.viewerLogin === null) this.viewerLogin = owner;
    return this.viewerLogin === owner;
  }

  // -- repositories ----------------------------------------------------------

  createRepo(name: string, opts: { privateFlag?: boolean; description?: string }): Repo {
    if (name === '' || name.includes('/')) throw new StoreError(422, 'Invalid repository name');
    if (this.repos.has(name)) throw new StoreError(422, 'Repository already exists');
    this.repoSeq += 1;
    this.dbIdSeq += 1;
    const repo: Repo = {
      name,
      dbId: this.dbIdSeq,
      createdSeq: this.repoSeq,
      privateFlag: opts.privateFlag ?? false,
      description: opts.description ?? '',
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      issueOrder: [],
      issueSeq: 0,
      pulls: new Map(),
      pullOrder: [],
      pullSeq: 0,
      comments: new Map(),
      commentSeq: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  repoGlobalId(repo: Repo): string {
    return globalId(`repo:${repo.name}`);
  }

  // -- refs ------------------------------------------------------------------

  /** The tip a ref name resolves to: a full ref, a branch short name, or a bare oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isOid(ref)) return repo.objects.has(ref) ? ref : undefined;
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const headed = repo.refs.get(`refs/heads/${ref}`);
    if (headed !== undefined) return headed;
    const tagged = repo.refs.get(`refs/tags/${ref}`);
    if (tagged !== undefined) return tagged;
    return undefined;
  }

  /** The tip of a branch (short name), or undefined when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Create a ref; 422 when it already exists or the target is unknown. */
  createRef(repo: Repo, ref: string, sha: string): void {
    if (!ref.startsWith('refs/')) throw new StoreError(422, 'Invalid ref name');
    if (repo.refs.has(ref)) throw new StoreError(422, 'Reference already exists');
    if (!isOid(sha) || !repo.objects.has(sha)) throw new StoreError(422, 'Unknown object');
    repo.refs.set(ref, sha);
  }

  /** Commit oids reachable from a tip, newest first (depth-first from the tip). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (oid: string): void => {
      if (seen.has(oid)) return;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') return;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) walk(parent);
    };
    walk(tip);
    return out;
  }

  /** The nearest common ancestor of two commits, or null when the histories are disjoint. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestors = new Set<string>();
    const queue: string[] = [a];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (ancestors.has(oid)) continue;
      ancestors.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const walkB: string[] = [b];
    const seenB = new Set<string>();
    while (walkB.length > 0) {
      const oid = walkB.pop()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) walkB.push(parent);
    }
    return null;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** Peel a tag ref to the first non-tag object it points at. */
  peel(repo: Repo, oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  // -- contents commits ------------------------------------------------------

  /**
   * Write one file on a branch, creating the branch from the default tip (or as
   * the root commit when the repository is empty) when it does not exist yet.
   * Returns the new commit sha and the blob sha. `expectedSha`, when given, must
   * match the file's current blob sha or the write is a 409.
   */
  putFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { commitSha: string; blobSha: string; created: boolean } {
    let tip = this.branchTip(repo, branch);
    if (tip === undefined) {
      // A new branch starts from the default branch's tip (or from nothing).
      const base = branch === repo.defaultBranch ? undefined : this.branchTip(repo, repo.defaultBranch);
      if (base !== undefined) {
        repo.refs.set(`refs/heads/${branch}`, base);
        tip = base;
      }
    }
    const blobSha = hashObject('blob', content);
    if (!repo.objects.has(blobSha)) repo.objects.set(blobSha, { type: 'blob', data: content });
    const files = tip !== undefined ? filesAtCommit(repo, tip) : new Map<string, string>();
    const existed = files.has(path);
    if (expectedSha !== undefined) {
      const current = files.get(path);
      if (current === undefined) throw new StoreError(409, 'File does not exist');
      if (current.toLowerCase() !== expectedSha.toLowerCase()) throw new StoreError(409, 'The file has changed since the given sha');
    }
    files.set(path, blobSha);
    const tree = buildTreeFromFiles(repo, files);
    const parents = tip !== undefined ? [tip] : [];
    const commitData = buildServerCommit(tree, parents, message);
    const commitSha = hashObject('commit', commitData);
    if (!repo.objects.has(commitSha)) repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha, created: !existed };
  }

  /** Delete one file on a branch with a new commit; 404 when the file is absent. */
  deleteFile(repo: Repo, branch: string, path: string, message: string, expectedSha?: string): { commitSha: string } {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) throw new StoreError(404, 'Branch not found');
    const files = filesAtCommit(repo, tip);
    const current = files.get(path);
    if (current === undefined) throw new StoreError(404, 'File not found');
    if (expectedSha !== undefined && current.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new StoreError(409, 'The file has changed since the given sha');
    }
    files.delete(path);
    const tree = buildTreeFromFiles(repo, files);
    const commitData = buildServerCommit(tree, [tip], message);
    const commitSha = hashObject('commit', commitData);
    if (!repo.objects.has(commitSha)) repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  // -- labels, issues, comments ----------------------------------------------

  createLabel(repo: Repo, name: string, color?: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color: color ?? 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: readonly string[] }): Issue {
    if (input.title === '') throw new StoreError(422, 'Title is required');
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = repo.labels.get(name);
      if (!label) throw new StoreError(422, `Label does not exist: ${name}`);
      labels.push(label);
    }
    repo.issueSeq += 1;
    const issue: Issue = {
      number: repo.issueSeq,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
    };
    repo.issues.set(issue.number, issue);
    repo.issueOrder.push(issue.number);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  /** Issues in creation order, filtered by state ('open' | 'closed' | 'all'). */
  listIssues(repo: Repo, state: string): Issue[] {
    const all = repo.issueOrder.map((number) => repo.issues.get(number)!).filter(Boolean);
    if (state === 'all') return all;
    return all.filter((issue) => issue.state === state);
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw new StoreError(404, 'Issue not found');
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    return issue;
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment {
    if (!repo.issues.has(issueNumber)) throw new StoreError(404, 'Issue not found');
    repo.commentSeq += 1;
    const comment: Comment = { id: repo.commentSeq, issueNumber, body };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): Comment[] {
    if (!repo.issues.has(issueNumber)) throw new StoreError(404, 'Issue not found');
    return [...(repo.comments.get(issueNumber) ?? [])];
  }

  issueGlobalId(repo: Repo, number: number): string {
    return globalId(`issue:${repo.name}:${number}`);
  }

  commentGlobalId(repo: Repo, id: number): string {
    return globalId(`comment:${repo.name}:${id}`);
  }

  // -- pull requests -----------------------------------------------------------

  createPull(
    repo: Repo,
    input: { head: string; base: string; title: string; body?: string },
  ): Pull {
    const headTip = this.branchTip(repo, input.head);
    const baseTip = this.branchTip(repo, input.base);
    if (headTip === undefined) throw new StoreError(422, `Head branch not found: ${input.head}`);
    if (baseTip === undefined) throw new StoreError(422, `Base branch not found: ${input.base}`);
    for (const number of repo.pullOrder) {
      const existing = repo.pulls.get(number)!;
      if (existing.headRef === input.head && existing.baseRef === input.base && existing.state === 'open') {
        throw new StoreError(422, 'A pull request is already open for this branch');
      }
    }
    repo.pullSeq += 1;
    const pull: Pull = {
      number: repo.pullSeq,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.head,
      baseRef: input.base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.pulls.set(pull.number, pull);
    repo.pullOrder.push(pull.number);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.get(number);
  }

  /** Pull requests in creation order, filtered by state ('open' | 'closed' | 'all'). */
  listPulls(repo: Repo, state: string): Pull[] {
    const all = repo.pullOrder.map((number) => repo.pulls.get(number)!).filter(Boolean);
    if (state === 'all') return all;
    return all.filter((pull) => pull.state === state);
  }

  pullGlobalId(repo: Repo, number: number): string {
    return globalId(`pr:${repo.name}:${number}`);
  }

  headSha(repo: Repo, pull: Pull): string {
    return this.branchTip(repo, pull.headRef) ?? ZERO_OID;
  }

  baseSha(repo: Repo, pull: Pull): string {
    return this.branchTip(repo, pull.baseRef) ?? ZERO_OID;
  }

  /**
   * The three-way merge of a pull request's head onto its base, over the file
   * maps. Returns the merged file map and whether any path conflicts.
   */
  threeWayMerge(repo: Repo, pull: Pull): { files: Map<string, string>; conflicts: string[] } {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) throw new StoreError(422, 'Branch not found');
    const baseCommit = this.mergeBase(repo, headTip, baseTip);
    const baseFiles = baseCommit === null ? new Map<string, string>() : filesAtCommit(repo, baseCommit);
    const headFiles = filesAtCommit(repo, headTip);
    const oursFiles = filesAtCommit(repo, baseTip);
    const merged = new Map<string, string>();
    const conflicts: string[] = [];
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...oursFiles.keys()]);
    for (const path of paths) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      const ours = oursFiles.get(path);
      if (head === ours) {
        if (head !== undefined) merged.set(path, head);
      } else if (head === base) {
        if (ours !== undefined) merged.set(path, ours);
      } else if (ours === base) {
        if (head !== undefined) merged.set(path, head);
      } else {
        conflicts.push(path);
      }
    }
    return { files: merged, conflicts };
  }

  /** MERGEABLE when the three-way merge is clean, CONFLICTING otherwise. */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    try {
      return this.threeWayMerge(repo, pull).conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
    } catch {
      return 'UNKNOWN';
    }
  }

  /**
   * Squash-merge an open pull request onto its base branch: one commit with the
   * merged tree, parented on the base tip. 404 for an unknown pull request, 405
   * for a conflicted one (and 405 when it is already merged).
   */
  mergePull(repo: Repo, number: number): { pull: Pull; sha: string } {
    const pull = repo.pulls.get(number);
    if (!pull) throw new StoreError(404, 'Pull request not found');
    if (pull.state !== 'open') throw new StoreError(405, 'Pull request is already closed');
    const { files, conflicts } = this.threeWayMerge(repo, pull);
    if (conflicts.length > 0) throw new StoreError(405, 'Merge conflict');
    const baseTip = this.branchTip(repo, pull.baseRef)!;
    const tree = buildTreeFromFiles(repo, files);
    const commitData = buildServerCommit(tree, [baseTip], `Merge pull request #${number} from ${pull.headRef}`);
    const sha = hashObject('commit', commitData);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FORGE_DATE;
    pull.mergeCommitSha = sha;
    return { pull, sha };
  }

  /** The changed files of a pull request: merge-base tree vs head tree. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) throw new StoreError(422, 'Branch not found');
    const baseCommit = this.mergeBase(repo, headTip, baseTip);
    const baseFiles = baseCommit === null ? new Map<string, string>() : filesAtCommit(repo, baseCommit);
    const headFiles = filesAtCommit(repo, headTip);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base === head) continue;
      let status: string;
      let additions = 0;
      let deletions = 0;
      if (base === undefined) {
        status = 'added';
        additions = countLines(repo, head!);
      } else if (head === undefined) {
        status = 'removed';
        deletions = countLines(repo, base);
      } else {
        status = 'modified';
        const diff = lineDiff(blobText(repo, base), blobText(repo, head));
        additions = diff.additions;
        deletions = diff.deletions;
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }
}

/** The text of a blob object, or '' when it is not a blob. */
export function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

function countLines(repo: Repo, oid: string): number {
  const text = blobText(repo, oid);
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/**
 * A small LCS line diff. Files here are small (the suite's blobs are a few KiB);
 * for very large inputs it falls back to a multiset line difference.
 */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    const oldCount = new Map<string, number>();
    for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const left = oldCount.get(line) ?? 0;
      if (left > 0) oldCount.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of oldCount.values()) deletions += left;
    return { additions, deletions };
  }
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}
