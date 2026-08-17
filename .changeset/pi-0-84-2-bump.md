---
"@automatalabs/pi-acp": patch
---

ACP maintenance: bump the pi runtime to 0.84.2 (`pi-ai`, `pi-coding-agent`, `pi-agent-core`, exact pins).

0.84.2 is a mechanical patch — no breaking changes. Its entries are additive features (fullscreen
transcript search, a `defaultTools` setting, `--use-theme`, extension `expandPromptTemplates`,
`createGatewayBindingFetch`, `AssistantMessage.endTurn`) and fixes (TUI rendering/mouse/LaTeX, a
native Mistral Chat Completions transport replacing the SDK one, Google/Vertex tool-call stop
handling, and a JSON/RPC `message_update` cumulative-usage streaming fix). None touch the pi-acp
integration surface: pi-acp is a headless ACP server, so the TUI/mouse/LaTeX work is irrelevant; we
import no renamed or removed symbol; and the npm diff is confined to the internal
`@earendil-works/pi-*` family pins moving 0.84.1 -> 0.84.2.

The classifier fixtures re-verify byte-identically against the installed pi v0.84.2 runtime (E1
green — `auth-guidance.js` still emits `No API key found for ${providerDisplay}.` over
`getProviderLoginHelp()`, and `agent-session.js` still carries the "Authentication failed for" /
"Run '/login" / "to re-authenticate" prose the classifier keys on; pi-ai's
retry/overflow/error-body/provider-retry util dists are unchanged), so only the pinned versions
move: `FIXTURE_PI_PIN` and the exact-pin map in `packaging.test.ts`.
