import type { PiAcpDeps } from "@automatalabs/pi-acp";

declare const deps: PiAcpDeps;
deps.createAgentSession;
deps.sessions.create;
deps.modelRuntime;
deps.connectMcpClient;
deps.sleep;
deps.graceMs;
deps.mcpTimeoutMs;
