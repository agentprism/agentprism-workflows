---
"@automatalabs/pi-acp": patch
---

ACP maintenance: bump the pi runtime to 0.84.0 (`pi-ai`, `pi-coding-agent`, `pi-agent-core`).

0.84.0 is a feature+breaking release (fullscreen TUI, Mermaid/LaTeX, per-directory context
overrides, custom sampling params, Baseten provider). Its breaking items — renamed
`ModelsStreamTransforms`, cumulative `message`/`partial` fields removed from `message_update`,
signature changes to `getApiKeyAndHeaders()` / `refresh()` / `setRuntimeApiKey()` — do not
touch the pi-acp integration surface: typecheck and the full suite are clean, and we read only
`assistantMessageEvent.delta`, not the removed cumulative fields.

The three auth guidance strings the classifier fixtures pin moved from literal `"anthropic"`
forms to `${provider}` template literals in 0.84.0, but the classifier matches the stable
substrings those templates resolve to, so E1's classification expectations are unchanged. Only
the `FIXTURE_PI_PIN` moves, plus the exact-pin map in `packaging.test.ts`.
