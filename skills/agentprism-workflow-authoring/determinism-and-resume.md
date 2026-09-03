# Determinism and same-run continuation

Runs journal every completed `agent()` and `checkpoint()` result under a deterministic call index.
MCP `action:"resume"` continues the exact input run ID and never creates a child run.

## Identity

An agent identity includes the prompt, resolved model, authored mode and non-empty config options,
tier, phase, agent type and resolved definition, and schema. A separate input fingerprint covers
the label, cwd/isolation, keep-session flag, images, MCP servers, metadata, and approved script
backend digest. A cached result is usable only at the corresponding call with matching identity and
inputs. An interrupted non-result occurrence runs live and may reattach its ACP session when every
continuation gate passes.

Operational limits (`maxAgents`, concurrency, and retries) are runtime controls, not identity.
Changing them on resume does not change the stored script, args, routing, or prior usage.

## Canonical host configuration

New MCP runs atomically persist a versioned canonical host-owned effective agent configuration at
admission. It is indexed by stable agent occurrence and contains resolved values, not raw form
fields. Same-ID continuation inherits it without probing or eliciting again. If an old run lacks
that metadata, or later control flow reaches an uncovered occurrence, continuation fails closed and
the caller starts a fresh Run.

## Checkpoints

For a `checkpoint_required` pause, send one strict-JSON value keyed by the exact
`checkpointContext.callIndex`. Under the run lease, the first answer is journaled before script
continuation. Repeating the same answer is idempotent. A conflicting later answer is ignored and the
first durable answer remains authoritative on every reconstruction.

## What MCP does not support

MCP Run always admits explicit new content. It cannot name a prior run. MCP Resume accepts no
replacement script or args, source-run selector, or edited-content form.

To intentionally re-run completed work, start a fresh Run and change the script/prompt as needed.
To recover interrupted work, call:

```json
{ "action": "resume", "runId": "RUN_ID", "background": true }
```

The response and every later status/result call use the same `RUN_ID`, the same event stream, and
cumulative token usage.
