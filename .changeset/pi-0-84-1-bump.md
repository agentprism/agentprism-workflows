---
"@automatalabs/pi-acp": patch
---

ACP maintenance: bump the pi runtime to 0.84.1 (`pi-ai`, `pi-coding-agent`, `pi-agent-core`).

0.84.1 is a mechanical patch — it ships **no breaking changes** (unlike 0.84.0). Its entries are
additive features (Qwen Token Plan Individual provider, `pi auth check`, fullscreen mouse/word
selection and half-page scrolling, extension `tool_call` `terminate`) and fixes (Bun standalone
startup, extension TUI wrapper recursion, Windows fullscreen paste, `Agent.reset()` now rejecting
during active runs, LaTeX spacing, tmux/Zellij/Screen mouse volume). None touch the pi-acp
integration surface: pi-acp is a headless ACP server, so the TUI/mouse/LaTeX work is irrelevant; we
import no renamed/removed symbol; `Agent.reset()` is never called; and the npm dep diff is confined
to the internal `@earendil-works/pi-*` family pins moving `^0.84.0` → `^0.84.1`. Typecheck is clean
and the pi-acp packaging and classifier tests pass against the installed 0.84.1 dists; the ACP
freshness gate reports `@earendil-works/pi-*` at `0.84.1 == latest`, and the live acp-agents steering
e2e is green.

The classifier fixtures re-verify byte-identically against the installed pi v0.84.1 runtime (E1
green — the auth-guidance and provider-error prose still classify unchanged), so only the pinned
versions move: `FIXTURE_PI_PIN` and the exact-pin map in `packaging.test.ts`.
