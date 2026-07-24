# Workflow methodology patterns (optional reading)

Opinionated methodology distilled from real long-running workflow runs. These documents are
NOT part of the authoring skill: the skill teaches the script API and run operations; these
describe one way to structure high-stakes review and implementation workflows. Read them when
you want that methodology, not to learn the DSL.

- [`source-contract.md`](source-contract.md) — scope-fidelity discipline for translating a user request into prompts
- [`long-running-trains.md`](long-running-trains.md) — rules for multi-hour implement/review trains racing a moving repository
- [`implementation-train.workflow.js`](implementation-train.workflow.js) — a complete lens-gated implementation train applying those rules
