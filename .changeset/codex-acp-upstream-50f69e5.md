---
"@automatalabs/codex-acp": patch
"@automatalabs/pi-acp": patch
---

Sync the Codex ACP fork with upstream `main` through `50f69e5`, preserving the full non-squashed upstream history and AgentPrism fork extensions. The upstream changes add ACP v1 permission presentation/lifecycle handling and expose permission-mode kinds while retaining the existing mode IDs.

Update the embedded Pi runtime packages to 0.84.3. The release keeps model selection session-scoped by default, retains the existing steering APIs, and leaves provider-error classification unchanged.
