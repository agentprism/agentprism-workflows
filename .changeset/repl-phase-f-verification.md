---
"@automatalabs/repl-engine": patch
---

repl phase F — full-repo verification (round 2): the ENTIRE monorepo's CI gates pass green
with the phase A–E repl work in place — the frozen-lockfile install, the project-references
build, the monorepo typecheck, every package's test suite (shared-types, codex-acp,
pi-acp, workflow-engine, acp-agents, workflows, agentprism-otel, repl-engine, mcp-server),
the `check:acp-backends-manifest` and attribution gates, and now also the required ACP
dependency freshness gate (`node scripts/check-acp-deps.mjs` — green because this branch
carries the merged maintenance PRs: claude-agent-acp 0.65.0, pi 0.84.0, the
claude-agent-sdk 0.3.223 root override, and the codex-acp upstream syncs with their
attribution allowlist records).

The clause-by-clause sweep of docs/roadmap/repl-orchestrator.md against the code stands:
npm-shipped `quickjs.wasm` used as-is (no custom wasm build); fresh TypeScript guest library
(no vendored `dsl.js`); a single `repl` tool with the exact five actions; no budget surface
in the guest; snapshots at every state-changing boundary; the per-project `repl/` store
layout; the 6-subagent cap; the 256-line / 10 KB caps on text and structured content alike;
guest-visible steering outcomes; presence-keyed lifecycle with the drain bound reusing the
daemon's session-eviction TTL; plain handles with stable call ids and no canonical path
addressing; no inter-agent communication surface; `Date.now()`/`Math.random()` working
natively (pinned in `vm.test.ts`). No unfinished-work markers remain in the repl
code, and no doc-required behavior is deferred.
