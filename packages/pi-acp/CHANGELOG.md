# @automatalabs/pi-acp

## 0.2.2

### Patch Changes

- b46c70f: ACP dependency maintenance: pi runtime 0.81.0 (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, dev `@earendil-works/pi-agent-core`), `@agentclientprotocol/sdk` 1.3.0, and `@automatalabs/codex-acp` 1.6.9 (fork re-synced with upstream: MCP config-layer conflict fix, clearer config-load errors). Adapted pi-acp tests to pi-agent-core 0.81.0's required `streamFunction` option (renamed from `streamFn`); re-verified every pinned provider-error fixture string byte-identical against the 0.81.0 dists.

## 0.2.1

### Patch Changes

- 5cf8f96: Advertise Pi thinking levels per selected model, reject unrecognized values, and clamp recognized
  model gaps through Pi's SDK. Validate workflow thought levels against each call's selected model,
  including explicit clamp warnings and safe handling for backends without recognized-domain metadata.

## 0.2.0

### Minor Changes

- 3f8eb0e: Ship Pi's complete MCP client, standard StructuredOutput injection, configured model catalog,
  provider-error pin guard, tracked child cleanup, and end-to-end caller quarantine/timeout propagation.

## 0.1.3

### Patch Changes

- 0470ed1: Bump the embedded pi runtime to `@earendil-works/pi-coding-agent@0.80.10` (lockstep dev deps `pi-agent-core`/`pi-ai` included). Catalog-only upstream release — provider model metadata for Kimi/Moonshot/xAI/openrouter; no §14-cited surface changed (spec §0.3 repin note).

## 0.1.2

### Patch Changes

- 2beca1e: Promote Pi to a first-class built-in backend with exact-prefix model routing, native structured
  output, categorical provider errors, complete auth descriptors, bundled spawning, configuration
  discovery, and credential-free plus opt-in live end-to-end coverage. Update pi-acp's exact-pinned pi
  runtime and hermetic test dependencies to 0.80.9.

## 0.1.1

### Patch Changes

- 03b10b2: README: the custom-backend registration guidance now describes the current integration state and links the tracked built-in-backend issue instead of referencing an unfiled follow-up.

## 0.1.0

### Minor Changes

- f4f0f44: Add the in-process ACP server and reusable library adapter for the pi coding agent, embedding pi runtime 0.80.8.
