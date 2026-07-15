# image-gate — brief → produce → validate → feedback loop

A runnable example of the `gate()` DSL combinator, fronted by a repo-aware brief step:

```
┌────────────────────────────────────────────────────┐
│  Brief: agent studies the repo, writes an art-     │  (runs once)
│  direction prompt + the exact text to render       │
└────────────────────────┬───────────────────────────┘
                         ▼
┌────────────────────────────────────────────────────┐
│  Generate: agent + nanobanana MCP → image file     │◄──┐
└────────────────────────┬───────────────────────────┘   │
                         ▼                               │ feedback
┌────────────────────────────────────────────────────┐   │ (max 3 rounds)
│  Validate: agent VIEWS the image, judges it        │───┘ ok=false
│  against the brief + exact-text spelling           │
└────────────────────────┬───────────────────────────┘
                         ▼ ok=true (or attempts exhausted)
   { accepted, attempts, imagePath, verdict, concept, exactText }
```

- The **brief** agent explores the repo (`args.repoRoot`) with its own tools, then returns a
  self-contained image prompt plus `exactText` — the strings (brand name, short tagline) that
  must appear in the image verbatim. The brand comes from user input (`--brand`), so the image
  says "AgentPrism", not the repo slug.
- The **producer** agent gets the [nanobanana](https://github.com/gemini-cli-extensions/nanobanana)
  MCP server attached via the per-agent `mcpServers` option and is told to call its
  `generate_image` tool (or `edit_image` on retries). Structured output (`schema`) forces it to
  return `{ imagePath }`.
- The **validator** agent reads the image file with its own file-reading tool (Claude renders
  images) and returns `{ ok, feedback }` — rejecting for any misspelled/garbled required text.
  When `ok` is false, `gate()` hands `feedback` to the next producer attempt. The final
  structured validator return is also exposed unchanged as the result's `verdict`.
- Each round is a **fresh agent** — no session memory — so the script carries the previous
  image path in a closure and threads it into the retry prompt.

## Prerequisites

1. **Node ≥ 22** and this workspace built: `pnpm install && pnpm build` at the repo root.
2. **Claude backend auth** — a logged-in Claude Code install (`~/.claude`) or
   `ANTHROPIC_API_KEY` in the environment (the default backend for `agent()` calls).
3. **The nanobanana MCP server** — not on npm; clone and build it:

   ```bash
   git clone https://github.com/gemini-cli-extensions/nanobanana
   cd nanobanana/mcp-server && npm install   # `prepare` runs tsc → dist/
   ```

4. **A Gemini API key** for image generation (`GEMINI_API_KEY`).

## Run

```bash
cd packages/workflows/examples/image-gate

NANOBANANA_MCP=/abs/path/to/nanobanana/mcp-server/dist/index.js \
GEMINI_API_KEY=your-key \
node run.mjs --brand AgentPrism "an attractive README.md banner image for this repository"
```

`--brand <name>` sets the exact product name rendered in the image (default `AgentPrism`);
the remaining arguments are the request handed to the brief agent.

The brief and validator agents are pinned to the live-catalog-verified Claude id
`claude/claude-fable-5[1m]` via `args.models` in run.mjs. The registered prefix is stripped once
and the remaining id is sent verbatim; harness rejection follows the normal agent-error path.
The producer stays on the session default; its job is tool-calling, not judgment.

run.mjs passes `cwd: repoRoot` to `runDynamicWorkflow`, so every agent session runs at the
repo root and the brief agent explores with plain relative ls/grep. Generated images land in
`<repoRoot>/nanobanana-output/` (gitignored; the server hardcodes `<cwd>/nanobanana-output/`,
and its tool results report absolute paths, which is what the validator opens). Exit code 0 =
validator accepted the image.

## Notes

- The workflow script (`image-gate.workflow.js`) is read as **text** and executed in the
  engine's deterministic vm realm — `agent` / `gate` / `log` / `args` are realm globals, not
  imports, and the top-level `return` is valid there.
- `mcpServers` is additive wiring (not part of the resume identity hash) and needs no
  approval gate — unlike script-declared ACP `meta.backends`.
- Headless permission policy defaults to **allow**, so the nanobanana tool calls run without
  a human in the loop. Scope it down by giving the producer an `agentType` whose definition
  carries a tool allow-list, if you want tighter control.
