---
"@automatalabs/repl-engine": minor
---

New engine package for the REPL orchestrator: the QuickJS-in-WASM VM layer — one VM per workspace with workspace-owned lifecycle (create/eval/drain/dispose), eval with top-level await plus the job drain, per-VM `memoryLimit`, per-eval `interruptHandler`, and a structurally enforced trap-free result boundary (raw-export eval path that never constructs quickjs-wasi's getter-invoking `JSException`, trap-free drain errors, proxy-guarded descriptor reads, immediate disposal of exception/accessor handles so failed evals never accumulate guest memory, self-contained public wasm types). `quickjs-wasi` is used as-is including its shipped `quickjs.wasm` binary (pinned exact). This is phase A of the `repl-orchestrator` roadmap; the `repl` MCP tool registration lands in a later phase on top of `WorkspaceRegistry`.
