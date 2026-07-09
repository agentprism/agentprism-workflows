---
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": minor
---

MCP server auth tools (§4.3). Two additive, read-only/action tools register alongside the
single `workflow` tool — but only when the injected runner duck-types as auth-capable
(`describeAuthMethods`/`completeAuth`/`listBackends`/`auth`); a plain `AgentRunner` still gets
`workflow` alone, so `createWorkflowServer(runner)` is unchanged and default behavior is
byte-identical. `workflow_auth_status` reports each backend's redacted state + advertised
methods (ids/types/names/labels/flags only — never a value; enumerates every registered backend
when `backend` is omitted). `workflow_authenticate` maps `env`/`meta` (SECRET — handed straight
to the runner, never echoed, journaled, or logged) into an `AuthResolution`; a browser/TTY-only
interactive method returns `cancelled` with an explanation rather than a silent no-op. The
paused-run summary reads the structured `authContext` (never the message string) and points at
`workflow_authenticate` + `resumeFromRunId`. An opt-in inline elicitation resolver
(`createDeferredMcpAuthResolver`, env-gated OFF via `AGENTPRISM_MCP_INLINE_AUTH`) collects
env/gateway values through masked forms; the default headless path stays pure pause-and-resume.
The `@automatalabs/workflows` facade re-exports the runner-facing auth TYPES (§4.2 sequencing)
so `@automatalabs/mcp-server` can compile against them.
