---
"@automatalabs/workflows": minor
"@automatalabs/mcp-server": patch
---

`config` / `validate`: summarize oversized model catalogs instead of dumping them, and add
`config <harness> --models[=<filter>]` to reach the leaves.

Harnesses with large model catalogs (pi and opencode advertise hundreds) were printing every model
id inline in the `config` / `validate` option tables — and in `--json` — which floods an authoring
agent's context. Now any select option above 24 leaf choices (in practice the `model` option) is
rendered as a grouped summary (total + per-provider/group counts) on BOTH the human table and
`--json`; small catalogs (claude, codex, and every effort/mode/boolean option) are unchanged and
print verbatim. The grouping uses the harness-advertised optgroup names when present, else the model
id's first `/`-segment.

The full list is reachable only through the new `--models` flag: `config <harness> --models` prints
the provider/group breakdown (no leaf ids), and `config <harness> --models=<provider|substring|/regex/>`
prints the matching leaf ids. There is deliberately no unfiltered full-leaf dump on any surface, so
neither `--json` nor `--models` can flood context. The in-memory report and the programmatic
`probeHarnessConfig()` / `validateWorkflowScript()` returns stay complete — the collapse happens only
at the CLI print boundary — so `configOptions` validation still checks against every advertised model.
