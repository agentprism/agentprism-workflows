# Discriminated workflow action schema

Status: **implemented MCP contract**.

## Canonical discovery contract

The `workflow` tool publishes one draft-2020-12 `oneOf` with seven top-level branches, in this
order: `config`, `run`, `resume`, `status`, `result`, `permissions-response`, and `stop`. Every
object variant requires its literal `action`, lists only fields valid for that variant, and sets
`additionalProperties: false`. There is no root optional-field superset and no prose-only manual
discriminator after primitive validation.

The branch field sets are:

| Action | Required fields | Optional fields |
| --- | --- | --- |
| `config` | `action` | `projectDir`, `harnesses`, `modelSpecs`, `modelFilter` |
| `run` | `action`, exactly one of `script`/`scriptPath` | `projectDir`, `args`, `maxAgents`, `concurrency`, `agentRetries`, `background`; edited replay additionally requires `resumeFromRunId` before allowing `resumePolicy` or `checkpointReplies` |
| `resume` | `action`, `runId` | `args`, `maxAgents`, `concurrency`, `agentRetries`, `resumePolicy`, `checkpointReplies`, `background` |
| `status` | `action`, `runId` | `lastN`, `labelGlob`, `logLines`, `waitMs` |
| `result` | `action`, `runId` | `offset`, `maxBytes` |
| `permissions-response` | `action`, `runId`, `permissionId`, `response` | none |
| `stop` | `action`, `runId` | `lastN`, `labelGlob`, `logLines`, and either targeted `callIndex` or whole-run `forceOwner` |

Run uses four nested `oneOf` variants: fresh inline, fresh path, edited-replay inline, and
edited-replay path. This structurally enforces both content XOR and the dependency of replay policy
and checkpoint replies on a source run. Stop uses two nested variants so `callIndex` and
`forceOwner` cannot coexist. The permission response is itself discriminated between selected and
cancelled outcomes.

`projectDir` remains conditionally required for config/run by the shared daemon and optional on a
single-project in-process server; that deployment distinction is enforced after canonical schema
validation because both transports intentionally publish the same tool schema.

## Runtime and migration

The published and runtime canonical contracts are the same Zod union. Runtime defaults such as
status `waitMs: 0`, result paging defaults, background false, and execution clamps are applied only
after the union accepts one exact branch.

A narrow pre-validation compatibility normalizer preserves installed callers without advertising
competing choices:

- omitted `action` becomes `run`;
- legacy `inspect` becomes `status` with `waitMs: 0` and rejects an inspect request that supplied
  `waitMs`;
- legacy `await` becomes `status`, preserving explicit `waitMs` or using the historical omitted
  default of 20,000 ms.

Deprecated inspect/await TypeScript aliases remain migration input types only. They are not members
of `WorkflowToolInput`, not branches in JSON Schema, and not mentioned by the model-facing tool
description. There is one status handler and one status output contract.

## Protocol and verification

The production registration continues through the split MCP SDK v2 boundary. The stateful legacy
transport and stateless `2026-07-28` transport receive the same registered Standard Schema and
publish byte-equivalent input JSON Schema; no v1 SDK server object crosses into production.

The committed schema snapshot pins action order, branch-local properties, required sets, nested
run/stop variants, and `additionalProperties:false`. Runtime-versus-Ajv parity tests accept a
representative request for every canonical action and reject cross-action fields in both validators.
The dual-era HTTP test proves both transports publish the same seven-branch schema.
