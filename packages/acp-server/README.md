# `@automatalabs/acp-server`

Connection-pinned ACP V1 proxy for the backends configured through
`@automatalabs/acp-agents`. The `agentprism-acp-server` executable defaults to stdio and can also
listen for Streamable HTTP and WebSocket clients on one endpoint.

```bash
npx @automatalabs/acp-server                    # stdio
npx @automatalabs/acp-server --http             # http://127.0.0.1:7331/acp + ws://…
npx @automatalabs/acp-server --http --host 127.0.0.1 --port 8080 --path /acp
agentprism-acp-server --version
```

`--host`, `--port`, and `--path` apply only with `--http`; their defaults are `127.0.0.1`, `7331`,
and `/acp`. Each accepted HTTP or WebSocket connection has an independent discovery/backend mode
and pinned downstream connection.

The server accepts only clients that negotiate AgentPrism router extension version 1 under
`clientCapabilities._meta["@automatalabs/agentprism"].acpRouter`.

## Connection modes

A discovery connection initializes with:

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "_meta": {
      "@automatalabs/agentprism": {
        "acpRouter": { "versions": [1] }
      }
    }
  },
  "_meta": {
    "@automatalabs/agentprism": {
      "acpRouter": { "version": 1, "mode": "discovery" }
    }
  }
}
```

It may then call `_automatalabs/agentprism/backends/probe` with `cwd`, optional
`additionalDirectories`, and `mcpServers`. The probe opens one temporary no-prompt session per
configured backend and returns each backend's implementation information, capabilities, modes, and
configuration options.

An operational connection initializes with a backend selection:

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "_meta": {
      "@automatalabs/agentprism": {
        "acpRouter": { "versions": [1] }
      }
    }
  },
  "_meta": {
    "@automatalabs/agentprism": {
      "acpRouter": {
        "version": 1,
        "mode": "backend",
        "backend": "codex"
      }
    }
  }
}
```

The initialize request is forwarded unchanged to that backend. The backend response is returned
with the AgentPrism confirmation merged into `agentCapabilities._meta`. Every `session/new` repeats
the same backend assertion; after session creation, all ACP and non-AgentPrism extension traffic is
proxied unchanged over the pinned connection. Native backend session IDs remain unchanged and the
proxy stores no session-routing table.

Built-in backend IDs are `claude`, `codex`, `opencode`, and `pi`. Custom backends use the existing
`AGENTPRISM_BACKENDS` registry.

## Using the official TypeScript client SDK

Install the router, the official ACP TypeScript SDK, and a TypeScript runner:

```bash
pnpm add @automatalabs/acp-server @agentclientprotocol/sdk ws
pnpm add --save-dev tsx @types/node @types/ws
```

The following examples are consecutive sections of one `router-client.ts` file. They follow the
official SDK's [current client example](https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/examples/client.ts):
`client(...).onRequest(...).connectWith(...)`, `ctx.request(...)`, and the
`buildSession(...).withSession(...)` active-session API. The stdio helper starts a fresh
`agentprism-acp-server` process for each connection. The example permission handler rejects
safely; replace it with the application's actual user-confirmation UI.

### Shared client and stdio setup

```ts
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";

const ROUTER_NAMESPACE = "@automatalabs/agentprism";
const PROBE_METHOD = "_automatalabs/agentprism/backends/probe";

type ProbeBackendsParams = {
  cwd: string;
  additionalDirectories?: string[];
  mcpServers: acp.McpServer[];
  _meta?: Record<string, unknown> | null;
};

type BackendProbe =
  | {
      id: string;
      name: string;
      available: true;
      agentInfo?: acp.Implementation | null;
      agentCapabilities?: acp.AgentCapabilities;
      modes?: acp.SessionModeState | null;
      configOptions?: acp.SessionConfigOption[] | null;
      initializeMeta?: Record<string, unknown> | null;
      sessionMeta?: Record<string, unknown> | null;
    }
  | {
      id: string;
      name: string;
      available: false;
      stage: "initialize" | "session/new";
      error: string;
    };

type ProbeBackendsResult = { backends: BackendProbe[] };

class RouterClient implements acp.Client {
  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const reject = params.options.find(
      (option) => option.kind === "reject_once" || option.kind === "reject_always",
    );
    return reject
      ? { outcome: { outcome: "selected", optionId: reject.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      process.stdout.write(update.content.text);
    } else {
      console.error(`[${update.sessionUpdate}]`);
    }
  }
}

const client = new RouterClient();

function initializeRequest(
  mode: "discovery" | "backend",
  backend?: string,
): acp.InitializeRequest {
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "agentprism-router-example", version: "1.0.0" },
    clientCapabilities: {
      _meta: {
        [ROUTER_NAMESPACE]: {
          acpRouter: { versions: [1] },
        },
      },
    },
    _meta: {
      [ROUTER_NAMESPACE]: {
        acpRouter:
          mode === "discovery"
            ? { version: 1, mode }
            : { version: 1, mode, backend },
      },
    },
  };
}

async function withRouter<T>(
  operation: (ctx: acp.ClientContext) => Promise<T>,
): Promise<T> {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(pnpm, ["exec", "agentprism-acp-server"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (!child.stdin || !child.stdout) throw new Error("router stdio unavailable");

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  try {
    return await connectRouter(stream, operation);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

function connectRouter<T>(
  stream: acp.Stream,
  operation: (ctx: acp.ClientContext) => Promise<T>,
): Promise<T> {
  return acp
    .client({ name: "agentprism-router-example" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      client.requestPermission(ctx.params),
    )
    .connectWith(stream, operation);
}

async function withNetworkRouter<T>(
  transport: "http" | "websocket",
  operation: (ctx: acp.ClientContext) => Promise<T>,
): Promise<T> {
  const stream =
    transport === "http"
      ? createHttpStream("http://127.0.0.1:7331/acp")
      : createWebSocketStream("ws://127.0.0.1:7331/acp", { WebSocket });
  try {
    return await connectRouter(stream, operation);
  } finally {
    await stream.writable.close().catch(() => undefined);
  }
}

function withConfiguredRouter<T>(
  operation: (ctx: acp.ClientContext) => Promise<T>,
): Promise<T> {
  const transport = process.env.ACP_TRANSPORT ?? "stdio";
  if (transport === "stdio") return withRouter(operation);
  if (transport === "http" || transport === "websocket") {
    return withNetworkRouter(transport, operation);
  }
  throw new Error(`ACP_TRANSPORT must be stdio, http, or websocket; got ${transport}`);
}
```

The network adapters are the same official experimental transport APIs used by the SDK's current
HTTP server, HTTP client, and WebSocket client examples; the messages negotiated through them
remain ACP V1.

### Discover configured backends

Discovery uses one initialized connection and the router-owned probe extension. The generic
`request<Response, Params>()` overload is the official SDK path for custom methods:

```ts
const cwd = process.cwd();

const { backends } = await withConfiguredRouter(async (ctx) => {
  await ctx.request(
    acp.methods.agent.initialize,
    initializeRequest("discovery"),
  );

  return ctx.request<ProbeBackendsResult, ProbeBackendsParams>(PROBE_METHOD, {
    cwd,
    mcpServers: [],
  });
});

for (const backend of backends) {
  if (backend.available) {
    console.log(`${backend.id}: available (${backend.agentInfo?.name ?? backend.name})`);
  } else {
    console.log(`${backend.id}: unavailable at ${backend.stage}: ${backend.error}`);
  }
}
```

### Pin a backend, create a session, and prompt

Backend operation uses a second initialized connection. The selection is repeated in
`session/new`; the SDK's active-session helper then sends ordinary ACP traffic without additional
router metadata. `session.sessionId` is the selected backend's native session ID.

```ts
const selected = process.argv[2] ?? backends.find((backend) => backend.available)?.id;
if (!selected) throw new Error("No configured backend is available");

await withConfiguredRouter(async (ctx) => {
  const initialized = await ctx.request(
    acp.methods.agent.initialize,
    initializeRequest("backend", selected),
  );
  console.log(`Connected to ${selected} using ACP v${initialized.protocolVersion}`);

  await ctx
    .buildSession({
      cwd,
      mcpServers: [],
      _meta: {
        [ROUTER_NAMESPACE]: {
          acpRouter: { version: 1, backend: selected },
        },
      },
    })
    .withSession(async (session) => {
      console.log(`Native backend session: ${session.sessionId}`);
      session.prompt("Summarize this repository in three bullets.");

      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
          console.log(`\nStop reason: ${message.stopReason}`);
          return message.response;
        }

        await client.sessionUpdate(message.notification);
      }
    });
});
```

Run the file over stdio, or start `agentprism-acp-server --http` and select a network transport:

```bash
pnpm exec tsx router-client.ts codex
ACP_TRANSPORT=http pnpm exec tsx router-client.ts codex
ACP_TRANSPORT=websocket pnpm exec tsx router-client.ts codex
```

## Library API

```ts
import {
  listenAcpHttpServer,
  serveAcpServer,
} from "@automatalabs/acp-server";

await serveAcpServer(); // one stdio connection

const server = await listenAcpHttpServer({
  host: "127.0.0.1",
  port: 7331,
  path: "/acp",
});
console.log(server.url, server.webSocketUrl);
await server.close();
```

Embedding hosts can pass a custom ACP `stream`, custom backend registrations, exact `targets`, a
version string, and an abort signal through `ServeAcpServerOptions`. `ListenAcpHttpServerOptions`
adds `host`, `port`, `path`, and `maxRequestBodyBytes`; the returned handle exposes the bound URLs,
a `closed` promise, and idempotent `close()`. The package also exports the default network listener
constants, router constants, request parsers, response helpers, probe types, and backend-target
resolver.
