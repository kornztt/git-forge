# Strategy — git-forge (github-core-clone-01)

## The prize condition, and what it forces

The prize needs a score strictly above the house reference forge on the
final's 3 instances, with the 90% paired t-interval above 0. A partial
implementation earns $0. The reference is a full forge: it presumably scores
the whole 600 feature + 200 agent columns and about 100 of the 200
performance points at its own medians, so the bar is roughly 900/1000. The
strategy is therefore: **max out the two conformance columns first, then buy
as much performance margin as cheaply as possible, and never trade a passing
check for speed.**

## Breadth first, in this order

1. **Store + REST v3** — the largest feature surface (repos, issues, pulls,
   contents, branches, commits). One in-memory store, one owner, deterministic
   state.
2. **MCP** — the most contained 200 points: six tools on the same store,
   `server/discover` for the modern revision, legacy `initialize` as fallback,
   byte-identical `tools/list`.
3. **Git smart HTTP** — upload-pack v2 with v0 fallback, receive-pack v0,
   real packfiles from scratch, fast-forward-only pushes.
4. **GraphQL** — hand-rolled parser/executor with the introspection tables
   the suite requires; mutations readable back over REST.
5. **Performance** — allocation-light hot paths, fastest pack deflate, no
   per-request full scans.

## What not to do

- No git binary anywhere in the server (the server must never shell out to
  git); a real git client may drive it in tests.
- No npm install, no native addons, no outside services or proxies.
- No wall clock or unseeded randomness in served state; a replay must compare
  byte for byte.
- No pushing or submitting before the parent reviews; the remote repo is
  https://github.com/kornztt/git-forge and stays untouched until then.

## Where the margin comes from

The four workloads are all small-object, high-count work: 200 sequential
pushes, 50 concurrent depth-1 clones of a 200-commit repo, 2,000 sequential
GETs on one keep-alive connection, 200 sequential issue POSTs. The wins are
cheap ones — in-memory indexes, one JSON serialization per response, fastest
deflate for packs — not clever algorithms. Measured practice totals are
~928–944/1000 (600 feature + 200 agent + 128–144 perf), against a reference
bar near 900. The remaining perf headroom is small and noisy (the trial pod
shares 1.5 CPUs), so further tuning is only worth it if it does not risk a
conformance check.
