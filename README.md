# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kornztt/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kornztt/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, single-process, GitHub-compatible git forge for the
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty.
Node 22, standard library only — no install step, no git binary, no network
beyond the suite that drives it. One process serves four surfaces from one
in-memory store:

| Surface | Path | What it does |
| --- | --- | --- |
| git smart HTTP | `/{owner}/{repo}.git` | upload-pack v2 (v0 fallback) and receive-pack v0; packfiles built and parsed from scratch (loose objects + packs, OFS/REF deltas on read, plain objects on write), fast-forward-only pushes |
| REST v3 | `/api/v3/...` | repositories, branches, commits, contents, labels, issues, comments, pull requests |
| GraphQL v4 | `/api/graphql` | repository / issues / pullRequests, mutations, introspection, batched operations |
| MCP | `/mcp` | JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 (`server/discover`, legacy `initialize` fallback), six tools on the same store as REST |

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own; the flag is harmless there. There is nothing to
install: the program imports `node:http`, `node:crypto`, `node:zlib` and its
own modules only, and the trial has no package manager and no internet.

With `MAKEFUN_ENV_URL` unset the server listens on `$PORT` (default 18080)
and serves until stopped — the local development mode. In a trial the
variable is always set and `main.ts` runs the entry lifecycle instead:

1. **Bind an ephemeral port.** `server.listen(0)`; never 8080, the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": N}` as JSON.
   The first register wins; a later one is answered 409.
3. **Wait for done.** Poll `GET $MAKEFUN_ENV_URL/done` with a short
   exponential backoff until it answers `{"done": true}`.
4. **Exit 0.**

## Layout

- `main.ts` — the entry ↔ env lifecycle, plus the dev server when there is no env.
- `app.ts` — the HTTP server: routing, body reading, JSON error handling.
- `store.ts` — the store: repositories, objects, refs, issues, pull requests,
  labels, comments; deterministic server commits; three-way merge.
- `gitutil.ts` — pkt-lines, SHA-1 object ids, tree/commit/tag build and parse,
  pack write (plain objects, fastest deflate) and read (OFS/REF deltas).
- `git.ts` — smart HTTP: v2/v0 advertisements, ls-refs, fetch (with shallow
  and deepen), receive-pack with per-ref fast-forward checks.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — a hand-rolled GraphQL parser and executor with introspection.
- `mcp.ts` — the MCP endpoint and its six tools.

## Design decisions

- **Deterministic state.** No wall clock and no unseeded randomness anywhere
  in what is served: server commits use a fixed identity and timestamp, request
  ids are a counter, global ids are base64url of stable keys. A replay compares
  byte for byte.
- **One owner.** The token names one user. The viewer login is pinned from the
  first owner seen in a repo-path URL (the suite's fixed-seed viewer is the
  fallback); any other owner is a 404, never a 403.
- **Fetch planning.** A fetch sends only what the client lacks: objects
  reachable from the haves are held, except a shallow boundary's ancestors,
  which a shallow client does not hold — that is what makes `deepen` deliver
  exactly one more generation. Packs carry plain objects only; an empty pack
  is still sent with at least one sideband band-1 packet.
- **Limits.** One file ≤ 8 MiB, one repository ≤ 16 MiB, enforced in the store.

## Practice results

Against the kit's own trial runner (`sdk/run.ts`, trial-0 seed), from a fresh
server:

- Feature checks: **120/120** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, GraphQL 20/20.
- MCP checks: **15/15**.
- Performance (4 workloads, median of 3 rounds): push ~0.51–0.77 s, clone
  ~0.19–0.31 s, read ~1.4–1.6 s, write ~0.17–0.29 s — **128–144 / 200**
  against the house reference medians (push 1640.82 ms, clone 266.941 ms,
  read 2759.715 ms, write 348.965 ms).
- Total: **945 / 1000** on a clean re-run by the parent (feature 600 + MCP 200 + perf 145).

The two bugs the practice runs caught, and their fixes, are the interesting
part of the history: `routeRepo` sliced the path one segment short so every
`/repos/{owner}/{repo}` read 404'd, and the fetch planner first treated a
shallow client's boundary as holding its whole ancestry, which starved a
`deepen` fetch of the parent's tree.

---

<sub>Entered on [make.fun](https://make.fun/?ref=werh0je7&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
