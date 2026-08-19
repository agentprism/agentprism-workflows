# Session Config Options: Authoring Surface and Validate-Time Probe

**Date:** 2026-07-15

**References:** [ACP session config options](https://agentclientprotocol.com/protocol/v1/session-config-options); issue #156; `docs/specs/model-resolution-determinism.md` (the verbatim contract this extends)

## 1. Problem

ACP's session-config-options surface is the protocol's own mechanism for per-session knobs: at
`session/new` an agent advertises its options (model, reasoning effort, fast mode, and anything a
custom agent invents), and the client sets them with `session/set_config_option`. We consume this
surface internally — `SessionHandle` in `packages/acp-agents/src/acp-client.ts` receives and stores
the advertised `configOptions`, and its private `applyConfigOption()` drives them — but the only
option ever set is `"model"` (verbatim selection per the model-resolution contract), and nothing
user-facing exposes the rest. Since the bracket syntax was removed, reasoning effort is reachable
only through harness-global configuration (e.g. Codex `config.toml`), not per call.

Separately, workflow authors have no way to learn what a harness actually advertises before a run.
The advertised catalog is runtime state — per machine, login, harness version, and harness config —
so an authored option id or value can only be checked against the real thing. The validator is the
natural pre-flight surface: its dry run already records every `agent()` call's model spec and
backend attribution, so it already knows which harnesses a script routes to.

## 2. The contract

### 2.1 `configOptions` — the authoring surface

Add to the workflow DSL's `AgentOptions` (`packages/workflow-engine/src/workflow.ts`,
`packages/workflows/src/dsl.d.ts`), to acp-agents' `RunOptions`, and to `InteractiveSessionOptions`
(`ReattachSessionOptions` inherits):

```ts
configOptions?: Record<string, string | boolean>;
```

Semantics mirror the verbatim model rule exactly:

- Each entry is set via `session/set_config_option` on the advertised option with that **exact id**
  — no id aliasing, no value coercion, no interpretation. Strings for select options, booleans for
  boolean options, sent as authored.
- Applied after model selection and before the prompt, in **ascending lexicographic option-id
  order** so application order is deterministic regardless of object-key order or JSON source.
- A harness rejecting an id or value propagates on the **existing agent-error path** — no new error
  code, no retry, no fallback emission, no echo verification. The harness is the authority.
- The key `"model"` is rejected with a validation error before any session opens (engine-side,
  non-recoverable `SCRIPT_VALIDATION_ERROR`): the model has exactly one channel, the `model` param,
  and two channels would reintroduce precedence questions.

Replay identity: `configOptions` joins `hashAgentCall()` — it changes what the call *is*. To keep
every existing journal byte-valid, it is serialized into the canonical identity object **only when
present and non-empty** (the same omitted-when-unset pattern `mode` uses), as sorted-key JSON.
Resume-semantics documentation surfaces gain `configOptions` in the hashed-fields list.

### 2.2 Probe API — acp-agents

Expose the advertised catalog as a public read:

```ts
interface ProbedConfigOptions {
  backendId: string;
  /** The agent-advertised options, verbatim ACP shapes (id, name, type, currentValue, choices). */
  options: SessionConfigOption[];
}

class AcpAgentRunner {
  /** Route `spec` with the standard first-segment table, open one session (no prompt, zero
   *  tokens), read the advertised config options, close the session. Throws when the harness
   *  cannot spawn, authenticate, or open a session. */
  probeConfigOptions(spec?: string, opts?: { cwd?: string }): Promise<ProbedConfigOptions>;
}
```

`SessionConfigOption` is re-exported so consumers get the wire shape without reaching into the ACP
SDK. The probe uses the existing pooling/spawn machinery; it adds no new process semantics.

### 2.3 Validate-time surfacing and checking — workflows

After the dry run, `validateWorkflowScript()` takes the **distinct harnesses** the recorded calls
route to (via the same first-segment routing the runner uses, resolved against the default backend)
and probes each **once**, against the validate cwd. This always runs — there is no opt-out flag.
Two outputs:

1. **Advertised options are surfaced every time**, even for scripts that pass no `configOptions`:
   the human report prints, per harness, a table of option id, type, current value, and the select
   choices; the `--json` report carries:

   ```ts
   interface ValidateHarnessOptions {
     backendId: string;
     probed: boolean;
     /** Present when probed=false: why (spawn failure, auth, timeout) — the harness's own words. */
     error?: string;
     options?: SessionConfigOption[];
   }
   // ValidateWorkflowReport.dryRun gains: harnessOptions?: ValidateHarnessOptions[]
   ```

   **Oversized-catalog collapse (rendered surfaces only).** A harness with a large model
   catalog (pi, opencode advertise hundreds) would flood the reader, so at the *print
   boundary* any select option above `MAX_INLINE_SELECT_CHOICES` (24) leaf choices — in
   practice the `model` option — is summarized rather than enumerated, on BOTH the human
   table and the `--json` output. In `--json` the option's `options` array is replaced by
   `{ truncated: true, choiceSummary: { total, groups: [{ group, count }], expand } }`,
   grouped by advertised optgroup name or the id's first `/`-segment. This is applied only
   when serializing/printing (`agentprism-workflows config` and `validate` CLIs); the
   in-memory `ValidateHarnessOptions.options` and the programmatic `probeHarnessConfig()` /
   `validateWorkflowScript()` returns stay complete, so `configOptions` checking below still
   sees every advertised choice. The full leaf list is reachable only via
   `config <harness> --models[=<filter>]` (breakdown when bare; matching leaf ids when
   filtered by provider/substring or `/regex/`) — there is no unfiltered full-leaf dump on
   any surface.

2. **Authored `configOptions` are checked** against the probed catalog for every call whose harness
   probed successfully:
   - unknown option id → **error**;
   - select option value not among the advertised choices → **error**;
   - boolean option given a non-boolean → **error**;
   - the key `"model"` → **error** (mirrors the runtime rejection).

   Each error names the call label, option id, authored value, and the advertised alternatives.
   Any such error makes the report INVALID with the existing dry-run failure exit code `2` — the
   run would fail loudly at the harness anyway; validate's job is to say so before tokens are
   spent.

Degradation is per harness and non-fatal: a harness that cannot be probed produces one warning
(`could not probe codex — configOptions on its calls are unverified: <reason>`) in `warnings` and
`probed: false` in the JSON; calls routed to it skip option checking. A probe failure alone never
fails validation, so CI environments without agent auth keep their current validate behavior plus
warnings. `ValidatedAgentCall` gains an optional `configOptions` echo so the report shows what each
call asked for. The mock dry-run runner records `configOptions` but attaches no live semantics.

Documentation for validate changes from "no ACP processes" to: zero tokens; spawns each routed
harness once to read its advertised options; degrades with warnings when a harness is unavailable.

## 3. What this deliberately does not do

- No client-side option vocabulary, aliases, or defaults — ids and values are the harness's.
- No caching of probed catalogs — they are runtime state and are re-read on every validate.
- No MCP tool-schema change: `configOptions` is script-level; the `workflow` tool is untouched.
- No runtime pre-validation: execution stays verbatim-or-harness-error; validate is the pre-flight.

## 4. Compatibility & semver

Hash bytes are unchanged for every existing call (omitted-when-unset serialization). Existing
scripts, journals, resumes, and MCP requests behave identically. Validate output gains sections;
its process-spawning behavior change is documented. One coordinated release:

| Package | Change | Bump |
| --- | --- | --- |
| `@automatalabs/acp-agents` | `RunOptions.configOptions`, verbatim application, `probeConfigOptions`, `SessionConfigOption` re-export | minor |
| `@automatalabs/workflow-engine` | `AgentOptions.configOptions`, hash inclusion (omit-when-unset), `"model"`-key rejection | minor |
| `@automatalabs/workflows` | dsl.d.ts, validate probe/surfacing/checking, report types | minor |
| `@automatalabs/mcp-server` | regenerated authoring prompt | patch |
| `@automatalabs/shared-types` | none (unless the report types are shared — implementer verifies where validate types live today) | none/minor |

## 5. Test plan

- **workflow-engine**: hash byte-compat fixture (call without `configOptions` hashes identically to
  today, pinned bytes); hash sensitivity (adding/changing/reordering-keys of `configOptions`);
  replay hit/miss behavior; `"model"` key rejected before session open.
- **acp-agents**: entries applied in sorted-id order with verbatim values (fake-agent fixture
  records the wire calls); string/boolean passthrough; harness rejection propagates as the existing
  agent error with no retry; `probeConfigOptions` returns the advertised options verbatim, opens
  exactly one session and closes it, and throws cleanly on spawn/auth failure.
- **workflows**: harness detection from recorded calls (incl. default-backend routing and custom
  names); options surfaced in human + JSON reports every time; each error class (unknown id, bad
  select value, non-boolean, `"model"`) → INVALID exit 2 with the call label named; per-harness
  degradation warning with `probed: false` and skipped checks; `ValidatedAgentCall.configOptions`
  echo; mock runner records without semantics.
- **mcp-server**: authoring-prompt drift test with new sentinels (`configOptions`, probe
  surfacing).

## 6. Docs & skill updates

`skills/agentprism-workflow-authoring/SKILL.md` (teach `configOptions` + "validate surfaces each
harness's advertised options — read the table before picking values"), `reference.md` (agent()
option table row, hashed-fields list, validator section incl. degradation), root README,
docs/api.md, `packages/acp-agents/README.md`, `packages/workflows/README.md`, regenerate the
authoring prompt via `scripts/generate-authoring-prompt.mjs`, update prompt sentinels.

## 7. Implementation breakdown

One PR:

1. **M — acp-agents**: `RunOptions.configOptions` application, `probeConfigOptions`, re-export,
   tests.
2. **S — workflow-engine**: `AgentOptions` passthrough, hash inclusion with byte-compat, `"model"`
   rejection, tests.
3. **M — workflows**: routing-aware probe stage, report surfacing/checking/degradation, CLI
   rendering, tests.
4. **S — docs/skill sweep** + prompt regeneration + Changesets.
