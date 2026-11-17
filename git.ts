// git.ts — git smart HTTP: info/refs, upload-pack (v2 + v0) and receive-pack (v0).
//
// The protocol, as the suite's client speaks it:
//   - GET /{owner}/{repo}.git/info/refs?service=git-upload-pack
//       Git-Protocol: version=2  -> v2 capability advertisement ("version 2" ...)
//       otherwise                -> v0 ref advertisement (# service=... preamble)
//     GET ...?service=git-receive-pack -> always v0, with report-status,
//     side-band-64k and delete-refs.
//   - POST /{owner}/{repo}.git/git-upload-pack
//       v2: command=ls-refs (ref-prefix filtering, peel, symrefs) or
//           command=fetch (want/have/shallow/deepen, thin-pack) with a
//           sectioned response: acknowledgments, shallow-info, packfile
//           (sideband band 1 = the pack).
//       v0: want/have lines in two flush-separated sections; the response is
//           NAK/ACK + shallow lines + the sideband pack, unsectioned.
//   - POST /{owner}/{repo}.git/git-receive-pack (v0 only): a command list,
//     a pack, and a report-status answer framed in sideband band 1.
//     Fast-forward only: a non-fast-forward update is refused per ref with
//     "ng <ref> non-fast-forward" and the ref does not move.
//
// A missing repository is 404 on both services and the server stays up. A
// malformed request body is 400 and the server stays up.

import {
  ZERO_OID,
  decodePackets,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pkt,
  pktDelim,
  pktFlush,
  pktLines,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObj,
} from './gitutil.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'git-forge/1.0';
const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

/** A ref as the advertisement lists it. */
export interface ListedRef {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs of a repository, HEAD first, then sorted. */
export function listRefs(repo: Repo): ListedRef[] {
  const out: ListedRef[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: ListedRef = { oid, name };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== oid) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** The v2 capability advertisement. */
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The v0 ref advertisement for a service, with capabilities on the first line. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k shallow ofs-delta agent=git-forge/1.0 symref=HEAD:refs/heads/main'
      : 'report-status side-band-64k delete-refs ofs-delta agent=git-forge/1.0 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), pktFlush()];
  const refs = listRefs(repo);
  const headTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pkt(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/** Add a commit's tree closure (tree + blobs, not parents) to `sent`. */
/**
 * Every object the client already holds, from its haves. A have is held with
 * its tree closure, and — unless it is an old shallow boundary — with the
 * history below it. A shallow client does NOT hold a boundary's parents, so
 * the walk stops there: treating them as held would make a deepen fetch skip
 * objects the client still needs.
 */
function heldClosure(repo: Repo, oids: readonly string[], oldShallow: readonly string[]): Set<string> {
  const boundaries = new Set(oldShallow);
  const held = new Set<string>();
  const stack = [...oids];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!boundaries.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return held;
}

/** Add a tree and everything under it, except objects the client already holds. */
function addTreeClosure(repo: Repo, treeOid: string, sent: Map<string, GitObj>, skip: ReadonlySet<string>): void {
  const queue = [treeOid];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (sent.has(oid) || skip.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    sent.set(oid, object);
    if (object.type !== 'tree') continue;
    for (const entry of parseTree(object.data)) {
      if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
}

/**
 * Which objects a fetch sends, for wants/haves/shallow/deepen.
 *
 * The walk: from each want, generation 1 is the want itself. A commit is sent
 * when it is not a have. Parents are followed while there is no depth limit
 * and the commit is not a have (a have's ancestors are already held), or
 * while the generation is below the depth limit (a deepen extends below a
 * have). A sent commit is a new shallow boundary when it has a parent that
 * was neither sent nor held. An old boundary is unshallowed when it is held
 * and the fetch sent one of its parents.
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const haveSet = new Set(haves);
  const held = heldClosure(repo, haves, oldShallow);
  const sent = new Map<string, GitObj>();
  const sentCommits = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = wants.map((oid) => ({ oid, gen: 1 }));
  while (queue.length > 0) {
    const { oid, gen } = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const isHave = haveSet.has(oid);
      if (!isHave) {
        sent.set(oid, object);
        sentCommits.add(oid);
        const commit = parseCommit(object.data);
        addTreeClosure(repo, commit.tree, sent, held);
      }
      const follow = depth === undefined ? !isHave : gen < depth;
      if (follow) {
        const commit = parseCommit(object.data);
        for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
      }
    } else if (object.type === 'tag') {
      if (!held.has(oid)) sent.set(oid, object);
      const target = parseTag(object.data).object;
      if (!seen.has(target)) queue.push({ oid: target, gen });
    } else {
      if (!held.has(oid)) sent.set(oid, object);
    }
  }
  const shallow: string[] = [];
  for (const oid of sentCommits) {
    const object = repo.objects.get(oid)!;
    const commit = parseCommit(object.data);
    if (commit.parents.length === 0) continue;
    const cutOff = commit.parents.some((parent) => !sentCommits.has(parent) && !haveSet.has(parent));
    if (cutOff) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of oldShallow) {
    if (!haveSet.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit.parents.some((parent) => sentCommits.has(parent))) unshallow.push(boundary);
  }
  return { objects: [...sent.values()], shallow, unshallow };
}

/** Split pack bytes into sideband band-1 pkt-lines (payload <= 65516 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const piece = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (out.length === 0) out.push(pkt(Buffer.from([1])));
  return out;
}

/** Whether a have is an ancestor of (or equal to) any want. */
function commonHave(repo: Repo, wants: readonly string[], haves: readonly string[]): string | null {
  for (const have of haves) {
    for (const want of wants) {
      if (have === want) return have;
      const object = repo.objects.get(want);
      if (!object || object.type !== 'commit') continue;
      if (isAncestorOf(repo, have, want)) return have;
    }
  }
  return null;
}

function isAncestorOf(repo: Repo, ancestor: string, tip: string): boolean {
  const seen = new Set<string>();
  const queue = [tip];
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

// ---------------------------------------------------------------------------
// request parsing helpers
// ---------------------------------------------------------------------------

/** The data-packet lines of a v2 command request, split at the delim packet. */
function parseV2Command(body: Buffer): { command: string; head: string[]; tail: string[] } {
  const packets = decodePackets(body);
  const head: string[] = [];
  const tail: string[] = [];
  let seenDelim = false;
  let command = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (command === '' && line.startsWith('command=')) {
      command = line.slice('command='.length).replace(/\n$/, '');
      continue;
    }
    if (seenDelim) tail.push(line);
    else head.push(line);
  }
  if (command === '') throw new Error('missing command= line');
  return { command, head, tail };
}

/** The pkt-lines of a v0 fetch request, split at the flush between the sections. */
function parseV0Fetch(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | undefined } {
  const packets = decodePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  return { wants, haves, shallow, depth };
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

export interface GitRequest {
  owner: string;
  repoName: string;
  service: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(): GitReply {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
}

function badRequest(message: string): GitReply {
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** Resolve the repository for a git request (pinning the owner); null when missing. */
function resolveGitRepo(store: Store, owner: string, repoName: string): Repo | null {
  if (!store.ownerMatches(owner)) return null;
  return store.getRepo(repoName) ?? null;
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, req: GitRequest): GitReply {
  const service = req.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
  const repo = resolveGitRepo(store, req.owner, req.repoName);
  if (repo === null) return notFound();
  if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
    return { status: 200, contentType: UPLOAD_AD_CT, body: v2Advertisement() };
  }
  const body = v0Advertisement(repo, service);
  return { status: 200, contentType: service === 'git-upload-pack' ? UPLOAD_AD_CT : RECEIVE_AD_CT, body };
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, req: GitRequest): GitReply {
  const repo = resolveGitRepo(store, req.owner, req.repoName);
  if (repo === null) return notFound();
  const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  try {
    return v2 ? handleUploadPackV2(repo, req.body) : handleUploadPackV0(repo, req.body);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}

function handleUploadPackV2(repo: Repo, body: Buffer): GitReply {
  const { command, head, tail } = parseV2Command(body);
  if (command === 'ls-refs') return { status: 200, contentType: UPLOAD_RESULT_CT, body: lsRefsResponse(repo, head, tail) };
  if (command === 'fetch') return { status: 200, contentType: UPLOAD_RESULT_CT, body: fetchV2Response(repo, head, tail) };
  throw new Error(`unknown command ${command}`);
}

function lsRefsResponse(repo: Repo, head: string[], tail: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of tail) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  void head;
  const refs = listRefs(repo);
  const lines: string[] = [];
  const headTip = repo.refs.get('refs/heads/main');
  if (prefixes.length === 0) {
    const headLine = symrefs
      ? `${headTip ?? ZERO_OID} HEAD symref-target:refs/heads/main\n`
      : `${headTip ?? ZERO_OID} HEAD\n`;
    lines.push(headLine);
  }
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

function fetchV2Response(repo: Repo, _head: string[], tail: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const raw of tail) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    // thin-pack, no-progress, ofs-delta, filter, done, agent, object-format: no action needed.
  }
  for (const want of wants) if (!isOid(want)) throw new Error(`fetch wants a bad object id ${JSON.stringify(want)}`);
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pkt('acknowledgments\n')];
  const ack = commonHave(repo, wants, haves);
  if (ack !== null) {
    parts.push(pkt(`ACK ${ack}\n`), pkt('ready\n'));
  } else {
    parts.push(pkt('NAK\n'));
  }
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pkt('packfile\n'));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleUploadPackV0(repo: Repo, body: Buffer): GitReply {
  const { wants, haves, shallow, depth } = parseV0Fetch(body);
  for (const want of wants) if (!isOid(want)) throw new Error(`fetch wants a bad object id ${JSON.stringify(want)}`);
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  const ack = commonHave(repo, wants, haves);
  parts.push(pkt(ack !== null ? `ACK ${ack}\n` : 'NAK\n'));
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  return { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
}

/** POST /{owner}/{repo}.git/git-receive-pack (v0 only) */
export function handleReceivePack(store: Store, req: GitRequest): GitReply {
  const repo = resolveGitRepo(store, req.owner, req.repoName);
  if (repo === null) return notFound();
  try {
    return { status: 200, contentType: RECEIVE_RESULT_CT, body: receivePackResponse(repo, req.body) };
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Split a receive-pack body into its command list (up to the first flush) and
 * the pack that follows it.
 */
function splitReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in the command list');
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line in the command list');
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const commandText = nul >= 0 ? line.slice(0, nul) : line;
    const parts = commandText.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) throw new Error(`bad push command ${JSON.stringify(commandText.slice(0, 60))}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  return { commands, pack: body.subarray(offset) };
}

function receivePackResponse(repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = splitReceivePack(body);
  if (commands.length === 0) throw new Error('push needs at least one command');
  // Unpack first: every object the pack carries joins the store before any
  // ref is judged, so a refused ref still leaves its objects behind (git does
  // the same: unpack happens before the ref checks).
  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
      if (!verifyPackChecksum(pack)) unpackError = 'pack checksum mismatch';
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const result = applyPushCommand(repo, command);
      reportLines.push(result === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${result}\n`);
    }
  }
  const report = pktLines(reportLines);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    const piece = report.subarray(offset, Math.min(report.length, offset + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), piece])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/**
 * Apply one push command. Returns null on success, or the ng reason.
 * Fast-forward only: an update whose new tip does not descend from the old
 * tip is refused and the ref does not move.
 */
function applyPushCommand(repo: Repo, command: PushCommand): string | null {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/')) return 'invalid ref';
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return 'remote ref does not exist';
    if (oldOid !== ZERO_OID && current !== oldOid) return 'remote ref does not match';
    repo.refs.delete(ref);
    return null;
  }
  if (!repo.objects.has(newOid)) return 'object not found';
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return 'already exists';
    repo.refs.set(ref, newOid);
    return null;
  }
  // Update.
  if (current === undefined) return 'remote ref does not exist';
  if (current !== oldOid) return 'remote ref does not match';
  const object = repo.objects.get(newOid);
  if (!object || object.type !== 'commit') {
    // A non-commit update (e.g. a tag ref moved to a tag object) is allowed
    // when it points at the same object; anything else is not a fast-forward.
    if (newOid === oldOid) return null;
    return 'non-fast-forward';
  }
  if (!isAncestorOf(repo, oldOid, newOid)) return 'non-fast-forward';
  repo.refs.set(ref, newOid);
  return null;
}
