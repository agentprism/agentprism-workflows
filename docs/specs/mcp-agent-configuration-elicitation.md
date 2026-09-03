# MCP pre-execution agent configuration elicitation

**Status:** Implemented

## Source request

> Implement MCP elicitation before workflow execution so users can choose provider, model, and advertised configuration for each `agent()` call in one structured request. Include each call’s phase title and description. Support both legacy MCP clients advertising elicitation and modern 2026-07-28 clients using the repository’s dual-era SDK migration approach.

## Admission order

This is an MCP composition-root policy; the workflow script DSL and the ACP runner's standalone
default routing remain unchanged.

For `run`, the server performs these token-free steps before run admission:

1. parse/static validation;
2. trust approval for script-declared backends;
3. a mocked routing-discovery execution;
4. no-prompt probing of every routable host and approved script backend;
5. one MCP form elicitation covering every agent occurrence observed by the dry run;
6. a second complete mocked execution plus routed model/mode/config validation using the accepted
   selections; and
7. only then run-ID allocation, persistence, background-slot reservation, or live dispatch.

A form-capable client receives the configuration request. Clients without form elicitation use the
host's authored/automatic routing policy. In both cases the host materializes a complete canonical
effective occurrence map and enables strict coverage before admission. Agent-less workflows do not
elicit. Decline or cancel returns a tool error and creates no run.

## Form contract

MCP form schemas accept flat primitive properties, not nested per-call objects. The server therefore
uses deterministic occurrence-prefixed fields:

- one required provider/model single-select for each observed call;
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
the root and nested workflows. A selection replaces the authored provider-specific model, mode, and
non-model config values. Replacement prevents stale mode/option ids from leaking when the user
changes providers and lets omission select the new provider's defaults. Effective model, mode, and sorted config options enter
the existing call identity before journal lookup or runner dispatch. Call records and agent events
therefore report what actually ran.

When MCP selections are active, strict occurrence coverage is enabled. If live control flow reaches
an agent occurrence the mocked discovery path did not observe, that occurrence fails before opening
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
- one request containing multiple calls; and
- equivalent legacy and modern HTTP behavior through the shared server implementation.
