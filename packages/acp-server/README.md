# `@automatalabs/acp-server`

Connection-pinned ACP V1 proxy for the backends configured through
`@automatalabs/acp-agents`. The package exposes the `agentprism-acp-server` stdio executable and a
programmatic `serveAcpServer()` entry point.

```bash
npx @automatalabs/acp-server
agentprism-acp-server --version
```

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

## Library API

```ts
import { serveAcpServer } from "@automatalabs/acp-server";

await serveAcpServer();
```

Embedding hosts can pass a custom ACP `stream`, custom backend registrations, exact `targets`, a
version string, and an abort signal through `ServeAcpServerOptions`. The package also exports the
router constants, request parsers, response helpers, probe types, and backend-target resolver.

Authentication, authorization, workspace policy, HTTP, WebSocket, and ACP V2 are outside this
package.
