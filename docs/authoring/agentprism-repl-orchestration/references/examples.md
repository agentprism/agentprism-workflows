# REPL orchestration examples

## Interactive investigate, steer, implement, verify

First eval—retain the founding handle:

```js
const parser = agent("codex", "Investigate the parser test failure. Analyze only; do not edit yet.");
```

While it is actually running:

```js
agents()
```

```js
const steering = await parser.steer("Focus on token recovery after malformed metadata");
steering
```

After the founding answer:

```js
const analysis = await parser;
const fix = parser.queue("Implement the smallest correct fix and add focused tests");
const verify = parser.queue("Run the focused tests and report exact results");
const fixed = await fix;
const tested = await verify;
({ analysis, fixed, tested })
```

## Parallel structured reviews

```js
const verdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "reason"],
  properties: {
    ok: { type: "boolean" },
    reason: { type: "string" },
  },
};

const reviews = (await parallel([
  () => agent("claude", "Review the current diff for correctness", { schema: verdictSchema }),
  () => agent("codex", "Review the current diff for regressions", { schema: verdictSchema }),
  () => agent("opencode", "Review whether tests cover the changed behavior", { schema: verdictSchema }),
])).filter(Boolean);
reviews
```

## Decide after inspection

```js
const candidates = agent("pi", "Find up to five concrete reliability improvements", {
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: { type: "array", items: { type: "string" } },
    },
  },
});
```

Later:

```js
const found = await candidates;
found.items
```

Choose one after discussing it with the user, then continue the same session:

```js
const chosen = found.items[0];
const implementation = candidates.queue(`Implement only this item: ${chosen}`);
await implementation
```

## Human checkpoint

```js
const decision = checkpoint("Which candidate should be implemented?", {
  choices: found.items,
});
```

After receiving the human response:

```js
workspace().checkpoints
```

```js
checkpoint.answer("c4", found.items[1]);
const selected = await decision;
selected
```

## Recover from a long-running eval

If a tool result reports `running`, poll without side effects:

```json
{ "action": "eval", "projectDir": "/absolute/project", "code": "" }
```

Inspect state:

```js
({ agents: agents(), diagnostics: workspace().diagnostics })
```

Cancel only one identified call through an out-of-band tool call:

```json
{ "action": "interrupt", "projectDir": "/absolute/project", "id": "c7" }
```

Use interrupt without an id only for a runaway eval, not as a substitute for targeted call cancellation.

## Bounded hunt loop

```js
const seen = [];
const findings = await loopUntilDry({
  round: async (i) => {
    const h = agent("claude", `Round ${i + 1}: find new bugs not in ${JSON.stringify(seen)}`);
    const text = await h;
    const rows = text ? [text] : [];
    seen.push(...rows);
    return rows;
  },
  consecutiveEmpty: 2,
  maxRounds: 5,
});
findings
```

Keep interactive loops bounded even though the workspace persists indefinitely.
