# Issue #131 retained contracts

The current MCP workflow lifecycle is specified by:

- [`../workflow-action-schema.md`](../workflow-action-schema.md)
- [`../workflow-status-action.md`](../workflow-status-action.md)
- [`../workflow-resume-action.md`](../workflow-resume-action.md)

Earlier issue-train proposals for omitted actions, inspection/await aliases, bounded status waits,
and model-facing replay/fork inputs have been removed because none is an accepted compatibility
surface. This directory retains only the still-current gate-verdict and dry-run mock-answer
contracts:

- [`03-gate-verdict.md`](03-gate-verdict.md)
- [`04-dry-run-mock-answers.md`](04-dry-run-mock-answers.md)
