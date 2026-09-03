# Canonical workflow status action

Status: **implemented MCP contract**.

## Scope

The model-facing observation action is an immediate point-in-time read:

```ts
interface WorkflowStatusToolInput extends WorkflowRunInspectionOptions {
  action: "status";
  runId: string;
}
```

`lastN`, `labelGlob`, and `logLines` retain their validation, filtering, redaction, and projection
bounds. Status never waits or emits polling metadata. Callers that need a
later snapshot issue another status request; a status request never cancels, pauses, resumes, or
otherwise changes workflow execution.

A successful response contains the bounded `WorkflowRunStatus`, cumulative token usage, current
safe permission projection, optional permission interaction/acknowledgement, terminal `outcome`
when settled, script/result/events resource links, compact `latestActivity`, and immutable script
identity. The detailed event resource remains the durable cursor source; lower-level SDK ancestry
is not projected through MCP.

## Permission presentation

When a compatible client can elicit a permission decision, status presents the already-sanitized
public permission projection. The form names run ID, phase, agent label, backend, tool title, and
tool kind. It includes a credential-redacted, strictly bounded rendering of available `rawInput`,
`content`, and `locations`, so commands and file targets are visible. It also explains the exact
scope of every ordered advertised option: one request or the remainder of that agent session,
allow or reject. Private ACP session IDs and unredacted secrets never enter the form. If the safe
projection cannot retain the complete option set, the request fails closed instead of presenting an
ambiguous choice.

Clients without form elicitation receive the same safe `pendingPermissions` projection and answer
through `permissions-response` with one exact advertised option ID or cancellation.

## Protocol and verification

Legacy 2025 elicitation and modern `2026-07-28` `input_required` use the same status and permission
contracts. Tests cover immediate reads, terminal outcomes, unknown runs, redaction and byte bounds,
visible commands/file targets, exact option ordering/scope, private-session exclusion, and both
protocol eras.
