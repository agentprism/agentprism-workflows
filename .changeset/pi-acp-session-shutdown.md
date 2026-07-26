---
"@automatalabs/pi-acp": minor
---

Shut pi down the way pi shuts itself down: emit `session_shutdown` before `AgentSession.dispose()`.

`AgentSession.dispose()` aborts in-flight work and marks the extension context stale — it never tells extensions the session is over. Pi's own hosts do not call it bare; the interactive mode exits through `AgentSessionRuntime.dispose()`, which emits `session_shutdown` first. That event is pi's **only** extension-cleanup contract (`Extension` has no dispose hook, just a handler map), and it is where an extension releases what it owns, including any process it spawned.

pi-acp called `dispose()` alone, so extension cleanup never ran and those processes outlived the session. Because pi-acp embeds pi **in-process**, an unreaped grandchild is our grandchild: its `ChildProcess` handle keeps the host's event loop alive, so a pi-acp process can stop exiting on its own and has to be reaped by the pool's SIGKILL escalation instead. The out-of-process backends (claude, codex, opencode) never showed this — the OS reaps their trees. Both disposal paths (normal and failed-open) now go through `shutdownPiSession`, which never throws, so a broken extension handler cannot strand cleanup.

`PiAcpDeps` gains **`agentDir`**, the directory pi's settings, extensions, and MCP servers are loaded from. It defaults to pi's own `getAgentDir()` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`), so a running server picks up the operator's real pi configuration exactly as before — user pi config stays fully live. It is injectable because `newSession()` reads it *before* `createAgentSession`: the settings manager and resource loader are built from it, and the loader loads and starts the user's extensions at that point. A caller that stubs `createAgentSession` alone therefore still inherited the ambient configuration and everything it spawned, with no session runtime left to shut any of it down — which made the adapter's own suite load the developer's extensions and hang the test runner at exit on any machine with pi extensions configured. Callers that build `PiAcpDeps` by hand rather than through `resolveDeps` must now supply `agentDir`.
