# Roadmap

Where AgentPrism Workflows is headed. This is the **index**: each item links to a detailed
design document in [`docs/roadmap/`](docs/roadmap/) that lays out the envisioned feature, the
open questions, and the sequencing. Direction, not commitment — items can be reordered,
reshaped, or dropped as the ecosystem (especially the [Agent Client
Protocol](https://agentclientprotocol.com)) evolves. Feedback and discussion via issues are
welcome.

Shipped work is *not* tracked here — see the [CHANGELOG](https://github.com/VikashLoomba/agentprism-workflows/releases)
and [`docs/design-notes.md`](docs/design-notes.md) for what already exists.

## Status legend

| Status | Meaning |
| --- | --- |
| **next** | Actively being scoped; expected to be the next major work |
| **designed** | Design settled and recorded; awaiting build slot |
| **exploring** | Direction chosen; design still open |
| **watching** | Blocked on / tracking an external dependency |

## Items

| Item | Status | One-liner |
| --- | --- | --- |
| [Remote execution & the runner gateway](docs/roadmap/remote-execution.md) | next | Drive ACP agents over WebSocket instead of stdio subprocesses; a runner gateway that exposes any ACP agent server remotely |
| [Evals (`agentprism-evals`)](docs/roadmap/evals.md) | next | Workflow-level output and process evals built on journal replay and typed structured outputs |
| [Workspace model](docs/roadmap/workspace-model.md) | designed | Any folder is a workspace; snapshot via namespaced refs without polluting existing repos; workflows associated, never checked in uninvited |
| [Natural-language workflow authoring](docs/roadmap/nl-workflow-authoring.md) | designed | Generate workflow scripts from a conversation, validated through four layers before anything runs |
| [VS Code extension channel](docs/roadmap/vscode-extension.md) | exploring | A satellite editor surface layered on the MCP server, not a parallel implementation |
| [ACP v2 readiness](docs/roadmap/acp-v2-readiness.md) | watching | Side-by-side v1/v2 support once the v2 draft stabilizes and SDK codegen ships; upstream RFD watch list |
