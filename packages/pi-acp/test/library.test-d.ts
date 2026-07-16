import type { PiAcpDeps } from "@automatalabs/pi-acp";

declare const deps: PiAcpDeps;
deps.createAgentSession;
deps.sessions.create;
deps.modelRegistry;
deps.connectMcpClient;
deps.sleep;
deps.graceMs;
deps.mcpTimeoutMs;
