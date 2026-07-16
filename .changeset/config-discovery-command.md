---
"@automatalabs/workflows": minor
---

New `agentprism-workflows config [harness ...]` CLI command and `probeHarnessConfig()` API — validate's sibling. It runs the same no-prompt, zero-token config probe standalone (no script required) and reports each routable harness's advertised config-option catalog verbatim: model ids (including bracket variants like `opus[1m]`), effort levels, modes, and boolean knobs. Defaults to the built-in harnesses plus every `AGENTPRISM_BACKENDS` custom; a harness that cannot spawn or authenticate (or times out, `--timeout-ms`, default 60s) reports `probed:false` and exits 1 without blocking the others. `--json` emits the machine-readable `HarnessConfigReport` (per-harness entries in the same shape as validate's `harnessOptions`). Also exports `formatHarnessConfigReport()` and the `ProbeHarnessConfigOptions` / `HarnessConfigReport` types.
