---
"@automatalabs/workflows": minor
---

Add token-free workflow-script validation: the new package bin `agentprism-workflows`
(`npx @automatalabs/workflows validate <file>`) statically parses a script (meta literal,
syntax, determinism blocklist) and then dry-runs it in the real engine realm against an
in-process mock AgentRunner that fabricates schema-conforming results — no ACP process is
spawned, no tokens are spent, and no backend auth is needed. Checkpoints resolve to their
headless defaults, script-declared `meta.backends` are treated as approved (with a warning
that real runs require approval), and the report lists every agent call with backend
attribution plus warnings (phase mismatches, `headless: "abort"` checkpoints, agent-less
scripts). Exit codes: 0 valid, 1 parse failure, 2 dry-run failure, 3 usage error.

Programmatic API: `validateWorkflowScript(script, { args, dryRun, cwd, tokenBudget,
maxAgents, timeoutMs })` plus `fabricateFromSchema`, `formatValidateReport`,
`MOCK_TOKENS_PER_AGENT`, and the `ValidateWorkflowOptions` / `ValidateWorkflowReport` /
`ValidatedAgentCall` / `ValidatedCheckpoint` types.
