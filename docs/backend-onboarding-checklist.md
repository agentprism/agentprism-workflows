# Built-in backend onboarding checklist

A built-in backend implementation PR cannot merge until every item below is completed. For every
item, include a reviewable link to code, tests, documentation, logs, upstream evidence, or the PR
comment that records the result. When an item truly does not apply, write `not applicable` and the
reason; topology, absent custom auth, or similarity to another backend never makes an item vanish.

## Runtime, distribution, and engine evidence

- [ ] Link evidence for the real package or system prerequisite, license, spawn command/bin
  resolution, environment overrides, shutdown behavior, and minimum Node version.
- [ ] Identify the applicable engine authority: the workspace server package, the acp-agents host
  floor for an npm server, or the acp-agents host floor plus external prerequisite for a system
  command. Link the matching row/manifest/package evidence.
- [ ] For an npm server without `engines.node`, link proof of the absence and a runtime validation at
  the fallback host floor. If its declaration differs, do not normalize it locally: raise the host
  floor and row together when higher, or upgrade/replace/correct upstream when lower/noncanonical.
- [ ] For a system command, link its external runtime prerequisite and prove the host floor/row is
  sufficient. Raise both together when necessary.
- [ ] For a new workspace server, link its package metadata, root TypeScript project reference,
  build/test scripts, exports/bin/files, packaging tests, and changeset/release configuration.

## ACP protocol and behavior evidence

- [ ] Link a complete initialize-capabilities and custom `_meta` inspection. Link the central
  protocol-coverage row, installed-distribution probes where source exists, auth profile,
  auth/meta matrix disposition, and capability tests; explicitly record empty/unsupported areas.
- [ ] Link tests or live evidence for permissions, elicitation, fs/terminal/MCP handlers, session
  lifecycle, cancellation, structured output, provider errors, auth, pool reuse, and generic
  request/notification extension passthrough. A claim of shared behavior requires a test.

## Public surfaces and authoring evidence

- [ ] Link updates or a `not applicable` rationale for user/API/README examples, environment
  variables, package exports, changelogs, and `CONTRIBUTING.md`'s `When the dependency gate blocks`
  runbook. Link compatibility re-export shims for relocated public symbols.
- [ ] Update the relevant canonical Agent Skill references under `docs/authoring/`, including routing/model/configuration tables. Record `pnpm generate:authoring-skills`, the generated-skill drift/API-vocabulary results, and the committed generated artifact.
- [ ] Link the `packages/mcp-server/src/server.ts` tool/backend description update.

## Live, release, and gate evidence

- [ ] Link the backend's `packages/mcp-server/test/live-backend.e2e.test.ts` type/table entries:
  executable/bin probe, environment scope, setup/auth diagnostics, structured-output/pooling
  matrix, and schema-less smoke run. Record the exact authenticated command and result; the
  pre-push live gate remains mandatory.
- [ ] Link a zero-`node_modules` dependency-gate run or hermetic equivalent, then build, typecheck,
  package tests, full tests, authoring drift, and live-e2e results.
- [ ] Link changesets for every affected published package. For a new server workspace/package,
  link evidence that build, version, and publish ordering is correct.
