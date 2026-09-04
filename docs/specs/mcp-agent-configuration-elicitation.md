# MCP pre-execution agent configuration elicitation

**Status:** Implemented

## Source request

> Implement MCP elicitation before workflow execution so users can choose provider, model, and advertised configuration for each `agent()` call in one structured request. Include each call’s phase title and description. Support both legacy MCP clients advertising elicitation and modern 2026-07-28 clients using the repository’s dual-era SDK migration approach.

## Policy correction

> When using the MCP server, the agent authoring and running the workflow with the workflows tool starts the workflow with defined provider/model configuration, but for some reason the server is still sending elicitation requests. We're only supposed to be sending elicitation requests when the agent tries to use the workflows tool with a script that doesn't define some required configuration.

This supersedes the original every-call selection policy. Configuration elicitation now fills only
unresolved effective models. Per-call, agent-definition, resolved tier, phase, and meta models count
as configured, including backend-only specs that intentionally retain the harness default model.
Mode and non-model config options are optional; omission uses backend defaults and never triggers a
configuration form. Invalid authored configuration still fails routed validation rather than opening
a form to replace it. Backend-spawn approval, checkpoints, and live ACP permissions retain their
separate interaction contracts. Existing canonical admission snapshots remain valid for continuation;
the new policy applies only to new runs and requires no persistence migration.

## Admission order

This is an MCP composition-root policy; the workflow script DSL and the ACP runner's standalone
default routing remain unchanged.

For `run`, the server performs these token-free steps before run admission:

1. parse/static validation;
2. trust approval for script-declared backends;
3. a mocked routing-discovery execution;
4. if a form-capable client has observed calls with unresolved models, no-prompt probing of every
   routable host and approved script backend;
5. one MCP form elicitation covering only those unresolved occurrences, if any;
6. a second complete mocked execution plus routed model/mode/config validation using preserved
   authored configurations and accepted selections; and
7. only then run-ID allocation, persistence, background-slot reservation, or live dispatch.

A form-capable client receives a configuration request only when an observed model is unresolved.
Clients without form elicitation use the host's authored/automatic routing policy. In both cases
the host materializes a complete canonical effective occurrence map and enables strict coverage
before admission. Agent-less and fully configured workflows do not elicit configuration. Decline
or cancel returns a tool error and creates no run.

## Form contract

MCP form schemas accept flat primitive properties, not nested per-call objects. The server therefore
uses deterministic occurrence-prefixed fields:

- one required provider/model single-select for each observed call with an unresolved model;
- one optional mode single-select per call and provider when modes are advertised; and
- optional select/boolean fields for every non-model ACP session option advertised by that provider.

Each field identifies the call ordinal and provider. Its description includes the call's resolved
label, phase title, the phase's optional `detail`, and a credential-redacted, strictly bounded task
prompt preview; the request message lists the same useful preview for every call. Provider-specific
fields are applied only when their provider is the selected route, so a
client that returns defaults for other provider groups cannot leak configuration across backends.

Provider/model values are exact routed specs. Mode, select, and boolean responses are checked against
the catalog that produced the form. The final routed preflight selects the chosen model and remains
the authority for model-specific option validation. Probe failures are omitted from choices and
reported in bounded form diagnostics. If no provider can be represented, admission fails.

## Engine and replay identity

The engine accepts host-selected configurations keyed by a zero-based occurrence ordinal shared by
the root and nested workflows. For an unresolved call, a selection supplies its model and replaces
any authored provider-specific mode and non-model config values. Replacement prevents stale
mode/option ids from leaking when the user chooses a provider and lets omission select that
provider's defaults. Calls with resolved models are absent from the form and retain all of their
authored model/mode/config values. Effective model, mode, and sorted config options enter the existing
call identity before journal lookup or runner dispatch. Call records and agent events therefore
report what actually ran.

Both authored and elicited configurations populate the complete occurrence map, and strict occurrence
coverage is enabled for every MCP admission. If live control flow reaches an agent occurrence the
mocked discovery path did not observe, that occurrence fails before opening
an ACP session instead of silently using an ambient provider. Earlier observed calls may already have
run; this is the unavoidable boundary of execution-based discovery for data-dependent control flow.
That first uncovered occurrence is recorded durably; later continuation fails closed rather than
shifting an ordinal onto a different call.

At admission the host atomically persists a versioned canonical effective configuration snapshot:
the occurrence map, host-pinned default model, approved script-backend map, stable selection hash,
source, and timestamp. Raw MCP form field names and returned form content are never persisted.
`action:"resume"` continues the same run with this exact snapshot and performs no new routing
discovery or configuration elicitation. A missing, invalid, or uncovered admission cannot continue.

## Dual-era transport

One implementation uses the split MCP SDK v2 `inputRequired` helper and signed request-state codec.

- On legacy sessions, the SDK's compatibility shim issues `elicitation/create` and re-enters the same
  handler with the response.
- On modern `2026-07-28` requests, the tool returns `input_required`; the client retries with
  `inputResponses` and integrity-protected `requestState`.

The signed state binds the original workflow arguments, admitted script bytes, approved
script-backend keys, and the exact selection-form hash. A changed script or tampered state is rejected;
a changed catalog reissues the current form rather than accepting a stale response.

## Tests

Credential-free coverage pins:

- flat-schema generation, phase context, bounded/redacted task previews, provider scoping, and catalog rejection;
- effective model/mode/config dispatch and call-record identity;
- atomic canonical admission, inherited same-ID continuation, and durable strict rejection of an uncovered occurrence;
- no configuration form for fully configured calls, including inherited and backend-only models;
- one request containing only unresolved calls, with configured calls preserved in mixed workflows;
- invalid authored config rejection without elicitation or dispatch; and
- equivalent legacy and modern HTTP behavior through the shared server implementation.
