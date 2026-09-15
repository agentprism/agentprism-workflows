---
"@automatalabs/codex-acp": minor
---

Sync with upstream agentclientprotocol/codex-acp main (non-squashed subtree merge of `a7afd2a`, upstream release 1.12.0).

- Set the standard ACP `name` on tool-call events (#513): every initial `tool_call` now carries the programmatic tool name next to the existing `_meta` decoration. Additive; AgentPrism's runner prefers this field for tool-policy matching and history entries.
- Supply validated diff statistics on file-change updates through `_meta.jetbrains.air.diffStats` (#501): added/removed line counts computed from the parsed patch or the supplied content, so clients can render file cards without re-diffing. Additive `_meta`; the fork's client-fs snapshots were refreshed to carry the block.
- Derive the AIR `agentFileChangeReport` from Codex `turn/diff/updated` snapshots instead of a hidden ephemeral fork and an extra model turn (#518); the version-1 wire contract and path limits are preserved.
- Improve `request_user_input` elicitation forms (#299): the full question becomes the title, the short header the description, and a picked option is preserved alongside a `user_note` answer instead of being replaced by custom text.
- Bump `@openai/codex` to ^0.154.0 (#494); the generated app-server types gain required `originator`/`toolsError`/`normalModelSlug`/`ordinaryUsageAllowed` fields, and the fork-owned loaded-turn fixture was updated accordingly.
- Upstream's npm publish polling (#499) and hono dev-dependency bump (#488) are not adopted; the fork keeps its workflow deletions and releases through root Changesets. The fork-owned `outputSchema` forwarding, goal, `_session/loaded_turn`, and client-backed file-read extensions were re-merged with upstream's new `collectTurnDiffs` constructor parameter placed before the fork-owned trailing parameters, and re-verified against the fork's 688-test suite.
