# Examples

Runnable examples for the `@automatalabs/workflows` SDK, in two shapes: **single-script
examples** (a workflow script plus a small host runner, importing the workspace build)
and **project examples** (a complete standalone package that depends on the published
SDK and can be copied out of this repo unchanged).

| example | shape | what it shows |
|---|---|---|
| [`repo-triage/`](repo-triage/) | **project** — own `package.json`, TypeScript host, external workflow scripts | An autonomous, unattended multi-stage triage mixing three complementary built-in backends per call. The broadest DSL tour: `pipeline`/`parallel`, `gate` with its terminal review verdict exposed, nested `workflow()` by name, `loopUntilDry`, `completenessCheck`, structured output, read-only session modes, token-budget guards, `openWorkflowDir`-style name loading, and the `validate` CLI. |
| [`image-gate/`](image-gate/) | **single script** + host runner (`run.mjs`) | The `gate()` produce → validate → feedback loop on a visual task: a brief agent, an image-generating producer wired to an MCP server via the per-agent `mcpServers` option, and a validator whose terminal structured verdict is returned with the final image. |

Each example's README covers its prerequisites (backend auth, external tools) and how
to run it. Before running a script you edited, validate it for free:

```bash
npx @automatalabs/workflows validate <script-or-name> [--workflows-dir <dir>]
```
