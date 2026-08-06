---
"@automatalabs/mcp-server": minor
---

Run monitor: push `ui/update-model-context` at milestones only

The MCP Apps run-monitor panel mirrored run status into the host's model context on nearly
every fold of its event stream — agent starts, banner changes, and token/cost tallies all moved
the push signature, so a run with N agents produced ~2N pushes plus steady churn while nothing
decision-relevant had happened. Each push also enumerated per-agent failure text, turning a
context-mirroring channel into a log feed. In hosts that treat a context update as
conversational input, every one of those pushes reached the agent.

Pushes are now limited to three milestones: an agent call going terminal (done or error), a
phase start (carrying the phase title and its ordinal), and the run reaching a paused or
terminal state. Live-view detail — agent starts, banners, progress rows, transcript tokens,
token/cost totals — no longer pushes on its own; it stays in the panel and the event log, which
the agent can read on demand. Push content is now shaped as YAML frontmatter plus a prose
sentence per the MCP Apps context pattern, and failure detail is summarized to the first
failure with a remaining count instead of enumerated.

Also fixes two leaks in the same channel: the panel's `onteardown` handler was a no-op, so a
dismissed or replaced panel kept polling the app-only events tool and kept pushing context from
a detached iframe; teardown now latches both channels off permanently. The event poll interval
moves from 1s to 2s, matching the cadence in the MCP Apps "polling for live data" pattern.
