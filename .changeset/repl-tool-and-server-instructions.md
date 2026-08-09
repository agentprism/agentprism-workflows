---
"@automatalabs/mcp-server": minor
"@automatalabs/workflows": patch
---

mcp-server: add tool-use instructions and server instructions.

The `repl` tool description now explains how a calling agent writes the eval `code`: the in-VM bridge (`agent()`, `checkpoint()`/`checkpoint.answer()`, `console` with addressable `$N` slices, handle methods `followUp`/`steer`/`cancel`), the guest library (`parallel`/`pipeline`/`verify`/`judgePanel`/`gate`/`retry`/`loopUntilDry`), started-not-awaited handles, stable call ids, and the `eval`/`wait`/`status`/`interrupt`/`reset` loop — alongside the existing persistence/reconciliation notes.

The server now returns MCP `instructions` in its initialize response, orienting a host/agent to the two model-facing tools and when to reach for each: `workflow` for deterministic, resumable batch orchestration and `repl` for interactive, stateful orchestration.
