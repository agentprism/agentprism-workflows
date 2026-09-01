# MCP `validate` action

**Status:** exploring · **Updated:** 2026-07-15

The validator — static parse, mock dry run with scripted mock answers, and the per-harness
config-options probe — ships in `@automatalabs/workflows` as a CLI and a programmatic API, but
the MCP `workflow` tool's actions are `run`/`inspect`/`await`/`stop` only (the server also
registers a separate `repl` tool, which is unrelated to script validation). An MCP host that
wants to validate a script before spending tokens has to shell out to the CLI or embed the SDK,
neither of which fits hosts that only speak MCP.

## Direction

Add `action: "validate"` to the `workflow` tool: accept a script plus the validator's
existing knobs (`args`, `mockAnswers`, `maxAgents`), run
`validateWorkflowScript` in the server process, and return the report — including the probed
per-harness advertised options, which is how an MCP-only host learns what models, modes, and
config options its installed harnesses actually accept.

## Open questions

- Report projection: the full `ValidateWorkflowReport` vs. a bounded projection consistent with
  the inspect action's redaction and byte caps.
- Whether the config probe runs by default in the server context (it spawns each routed
  harness once) or behind an input flag.
- Input limits for `mockAnswers` parity with the CLI's caps.
- Whether validate consumes a background slot (it should not — it is bounded and token-free,
  but the probe does spawn processes).
