# `@automatalabs/acp-server`

Connection-pinned ACP V1 aggregation over stdio, Streamable HTTP, and WebSocket. Backend selection
happens at the transport boundary, before ACP `initialize`; backend connections are transparent to
ordinary ACP clients.

## Run

Stdio serves exactly one explicitly selected endpoint:

```bash
npx @automatalabs/acp-server --backend codex
npx @automatalabs/acp-server --backend claude
npx @automatalabs/acp-server --discovery
```

A network listener exposes the complete endpoint hierarchy:

```bash
npx @automatalabs/acp-server --http
npx @automatalabs/acp-server --http --host 127.0.0.1 --port 8080 --base-path /acp
```

With the default base path, HTTP and WebSocket use the same routes:

```text
/acp/discovery
/acp/backends/claude
/acp/backends/codex
/acp/backends/opencode
/acp/backends/pi
/acp/backends/{custom-backend}
```

Only configured backend IDs are mounted. Unknown backend paths and the former single `/acp`
endpoint return `404`. A stdio invocation without exactly one of `--backend <id>` or `--discovery`
fails before reading ACP input. Run `agentprism-acp-server --help` for all CLI options.

## Backend endpoints

Connect an ordinary ACP V1 client directly to `/acp/backends/{id}` or launch stdio with
`--backend <id>`. Send a standard ACP initialize request; no AgentPrism capability or routing
metadata is required:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {},
    "clientInfo": { "name": "my-client", "version": "1.0.0" }
  }
}
```

The server opens the selected backend, forwards the initialize request unchanged, and returns the
backend's initialize response unchanged. Every later ACP message and extension message is proxied
in both directions without rewriting native session IDs or `_meta`. The connection owns backend
selection, so `session/new` contains only the backend's normal inputs:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/absolute/project/path",
    "mcpServers": []
  }
}
```

There is no session-routing table. One network transport connection or stdio process remains pinned
to one backend for its lifetime.

## Discovery endpoint

Connect to `/acp/discovery` or launch stdio with `--discovery`, then send the same standard ACP V1
initialize request. The response advertises the discovery extension under
`agentCapabilities._meta["@automatalabs/agentprism"].backendDiscovery`.

Call `_automatalabs/agentprism/backends/probe` on that initialized connection:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "_automatalabs/agentprism/backends/probe",
  "params": {
    "cwd": "/absolute/project/path",
    "additionalDirectories": ["/absolute/shared/path"],
    "mcpServers": []
  }
}
```

The result has one entry per configured backend:

```json
{
  "backends": [
    {
      "id": "codex",
      "name": "Codex",
      "available": true,
      "agentInfo": { "name": "codex-acp", "version": "..." },
      "agentCapabilities": {},
      "modes": { "currentModeId": "default", "availableModes": [] },
      "configOptions": []
    },
    {
      "id": "missing",
      "name": "Missing",
      "available": false,
      "stage": "initialize",
      "error": "..."
    }
  ]
}
```

A probe opens an isolated temporary connection to each backend, forwards the discovery connection's
initialize request, creates one no-prompt session using the probe inputs, captures initialize and
session capability catalogs, closes the temporary session, and tears down that connection. Probe
failures are isolated per backend. Discovery never selects an operational backend on its own
connection.

## Network client example

The official ACP SDK can connect to either HTTP or WebSocket backend paths without AgentPrism-aware
initialize metadata:

```ts
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";

const backend = process.argv[2] ?? "codex";
const transport = process.env.ACP_TRANSPORT ?? "http";
const path = `/acp/backends/${backend}`;
const stream = transport === "websocket"
  ? createWebSocketStream(`ws://127.0.0.1:7331${path}`, { WebSocket })
  : createHttpStream(`http://127.0.0.1:7331${path}`);

const result = await acp.client({ name: "example-client" }).connectWith(
  stream,
  async (context) => {
    const initialized = await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "example-client", version: "1.0.0" },
    });
    console.log(initialized.agentInfo);

    return context.buildSession({
      cwd: process.cwd(),
      mcpServers: [],
    }).withSession(async (session) => {
      session.prompt("Summarize this repository in three bullets.");
      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") return message.response;
        // Handle session updates and permission requests in a real client.
      }
    });
  },
);

console.log(result);
```

## Library API

```ts
import { serveAcpServer } from "@automatalabs/acp-server";

// Choose one endpoint for this stdio process.
await serveAcpServer({
  endpoint: process.env.ACP_DISCOVERY === "1"
    ? { kind: "discovery" }
    : { kind: "backend", backendId: "codex" },
});
```

A network host mounts every configured endpoint:

```ts
import { listenAcpHttpServer } from "@automatalabs/acp-server";

const server = await listenAcpHttpServer({
  host: "127.0.0.1",
  port: 7331,
  basePath: "/acp",
});
console.log(server.discovery.url);
for (const endpoint of server.backends) {
  console.log(endpoint.backendId, endpoint.url, endpoint.webSocketUrl);
}
await server.close();
```

`ServeAcpServerOptions.endpoint` is required and is either `{ kind: "discovery" }` or
`{ kind: "backend", backendId }`. Embedding hosts can also pass a custom ACP `stream`, custom
backend registrations, exact `targets`, a version string, and an abort signal.

`ListenAcpHttpServerOptions` adds `host`, `port`, `basePath`, and `maxRequestBodyBytes`. Its returned
handle exposes `basePath`, one `discovery` endpoint, the configured `backends` endpoint array, a
`closed` promise, and idempotent `close()`. `acpDiscoveryPath()` and `acpBackendPath()` construct the
canonical routes.

## Backend configuration

Built-ins are `claude`, `codex`, `opencode`, and `pi`. Resolution, command overrides, and custom
backend registration are shared with `@automatalabs/acp-agents`:

```bash
export AGENTPRISM_BACKENDS='{
  "team-agent": {
    "command": "node",
    "args": ["/opt/team-agent/server.js"],
    "env": { "TEAM_AGENT_TOKEN": "..." },
    "sessionMeta": { "tenant": "acme" }
  }
}'
```

This mounts `/acp/backends/team-agent` and permits `--backend team-agent`. Programmatic hosts can
supply the same map as `backends`, or exact `BackendTarget[]` entries as `targets`. IDs must match
`^[a-z][a-z0-9._-]*$`, making every backend path canonical and unambiguous.

Treat custom backend configuration as trusted operator input. Put per-backend secrets in the scoped
`env` overlay; the server adds no auth, tenant policy, filesystem mediation, or permission policy.
Expose a network listener only behind the access controls appropriate for the selected agents.
