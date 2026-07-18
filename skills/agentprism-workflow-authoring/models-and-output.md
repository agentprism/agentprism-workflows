## Choosing the agent for each call

The backend is selected **per `agent()` call** from its effective `model` string. This is the core capability: one script can plan on one vendor's agent, implement on another's, and review on a third's, handing structured results between them.

- **Omit `model` entirely** for maximum portability — the call runs on whatever default backend the host configured (`AGENTPRISM_DEFAULT_BACKEND`, or the host's session model). A script with no model specs anywhere runs unchanged on any backend.
- **Route by one registered first segment.** Split on the first `/`; ASCII-case-insensitive `claude`, `codex`, `opencode`, `pi`, or a registered custom backend name selects that harness and is stripped exactly once. A custom registration wins on a built-in-name collision.
- **Use a backend name alone** (`claude`, `codex`, `opencode`, `pi`, or a custom name) to preserve the harness's configured default model. No model config call is made.
- **Everything else goes intact to the default backend.** `anthropic/…`, `openai/…`, bare `opus`, and bare `gpt-…` are not routing aliases. When an id remains after routing, it is sent byte-for-byte: no catalog matching, case folding, bracket parsing, effort/Fast option driving, retry, or fallback. Brackets, dots, and provider prefixes are ordinary id characters; harness rejection is an agent error.
- **`tier`** (`"small" | "medium" | "big"`) is a coarse alternative resolved from the host's tier config — use it when you want "a cheap model" without naming a vendor.

The published examples use ids verified against live harness catalogs: `claude/opus[1m]`, `codex/gpt-5.6-sol`, and `opencode/zai/glm-5.2`. For Pi, `pi/openrouter/vendor/model-id` strips only `pi/`; Pi then splits provider `openrouter` from model id `vendor/model-id`. Prefer backend-only forms when the desired model is configured inside the harness.

Never guess model ids, effort values, or option names from memory — read the live catalog first:

```bash
npx @automatalabs/workflows config                # every routable harness (claude, codex, opencode, pi + registered customs)
npx @automatalabs/workflows config codex --json   # one harness, machine-readable
```

One no-prompt session per harness, zero tokens: the table lists every negotiable session option — model ids (including bracket variants like `opus[1m]`), effort levels, modes — exactly as the installed harness advertises them. This is the same probe the validator runs, available before a script exists; do NOT write a throwaway probe workflow (or read package internals) to discover options.

```js
const plan   = await agent(PLAN_PROMPT,          { label: "plan",      model: "opencode/zai/glm-5.2", schema: PLAN });
const impl   = await agent(implPrompt(plan),     { label: "implement", model: "codex/gpt-5.6-sol" });
const review = await agent(reviewPrompt(impl),   { label: "review",    model: "claude/opus[1m]", schema: REVIEW });
```

Use `configOptions` only for exact ACP session options advertised by that routed harness. Read the
per-harness advertised-options table first — `npx @automatalabs/workflows config <harness>`, or the
same table in every validator report — before choosing ids or select values; catalogs vary by
harness version, login, and machine.

```js
const impl = await agent(implPrompt(plan), {
  label: "implement",
  model: "codex",
  configOptions: { fast_mode: true, reasoning_effort: "high" },
});
```

Ids and string/boolean values pass through verbatim in ascending id order, after model selection
and before the prompt. There are no aliases, coercion, client-side vocabulary, defaults, or cached
catalogs. Never put `"model"` in `configOptions`; use the dedicated `model` field. A harness
rejection follows the ordinary agent-error path.

Two things worth designing for:

- **Cross-vendor independence.** Reviewing or verifying with a *different* vendor than the one that produced the work removes correlated blind spots — an agent family tends to approve its own idioms. When correctness matters, judge across vendors.
- **The harness is authoritative.** The client never substitutes a nearby model or silently falls back. A rejected id follows the existing agent-error path; a harness that accepts or ignores it determines the outcome. The public `fallbacks`/`onModelFallback` fields remain for compatibility but model resolution does not emit them.

## Structured output

Pass `schema` — a **plain JSON Schema object literal** (no schema builders exist inside the realm) — and the call resolves to a **validated object** instead of text:

```js
const FINDINGS = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "summary"],
        properties: {
          file:    { type: "string", description: "Repo-relative path — copy it exactly, never invent one" },
          line:    { type: "number", description: "1-indexed line the finding anchors to" },
          summary: { type: "string", description: "One sentence stating the defect, grounded in code you actually read" },
        },
      },
    },
  },
};

const report = await agent("Review the diff on this branch for correctness bugs.", {
  label: "review", schema: FINDINGS,
});
report.findings.forEach((f) => log(`${f.file}:${f.line} ${f.summary}`));
```

The same schema works on **every** backend; only the fulfillment channel differs, and the runner picks it for you: Claude uses its `outputFormat`, Codex its strict `outputSchema`, while Pi, OpenCode, and eligible custom ACP agents receive a client-hosted `StructuredOutput` MCP tool when they advertise HTTP MCP support. Pi accepts stdio, Streamable HTTP, and SSE MCP servers. If no valid tool capture exists, Pi retains the runner's common prompt-embedded schema and validated final-text JSON fallback. In every channel the runner validates the value client-side (with type coercion) and re-prompts a bounded number of times before failing the call with non-recoverable `SCHEMA_NONCOMPLIANCE`.

Schema authoring rules that keep all channels healthy:

- Root must be an object; set `additionalProperties: false` and list every property in `required`.
- Put a `description` on every field — descriptions are the per-field prompt, and they are the difference between grounded values and guesses.
- Keep schemas structurally simple. Exotic keywords (`oneOf`, `patternProperties`, unusual `format`s, backreference regexes) are normalized or stripped on the wire for some backends — validation still enforces them client-side, which shows up as re-prompt churn. Prefer `anyOf`, `enum`, and plain types.
- **Guard load-bearing fields against placeholders.** Agents under schema pressure sometimes emit `"TODO"`, `"unknown"`, or an invented path. Say "populate every field from evidence; never emit placeholder values" in the prompt, and check critical fields in script code (e.g. reject findings whose `file` doesn't appear in a known file list) before spending more agents on them.
