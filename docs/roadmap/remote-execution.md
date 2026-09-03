# Remote execution & the runner gateway

**Status:** next · **Updated:** 2026-07-10

Today the engine and the agents it drives are colocated: every backend is a subprocess
(`claude-agent-acp`, `codex-acp`, `opencode acp`, or a registry-declared custom command) spoken
to over stdio. The ACP [remote transport
RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport) (Active,
targeted as a **v1-additive** feature) standardizes driving agents over the network — one
`/acp` endpoint offering a streamable-HTTP/SSE profile and a WebSocket profile. This item adds
remote backends to the client side and a runner gateway on the serving side.

## Design

### 1. Remote backends (client side, `acp-agents`)

A backend config becomes a union — "a command I spawn" or "an endpoint I connect to":

```jsonc
{
  "image-gen":    { "command": "my-image-agent", "args": ["--acp"] },          // today
  "cloud-claude": { "transport": "ws", "url": "wss://runner.example/acp",
                    "auth": { "bearer": "…" } }                                 // new
}
```

The same union applies in all three existing config channels (programmatic `backends`,
`AGENTPRISM_BACKENDS`, script `meta.backends` — host still wins on name conflicts, which
matters *more* once a backend can be a URL). **Workflow scripts do not change**: `agent()`
routing, structured outputs, checkpoints, budgets, and journaling are transport-blind. The
implementation swaps exactly one seam: the SDK's `ndJsonStream` over child stdio becomes
`createWebSocketStream` from `@agentclientprotocol/sdk` — both return the same `Stream`, so
everything above the connection layer is untouched. Connection pooling keys by endpoint
instead of by child process.

### 2. WebSocket-first

The WS profile is the first target because (a) the TypeScript SDK already ships experimental
client *and* server support for it, (b) a WS-only server is spec-legal (remote clients must
support both profiles; servers may support only WS), and (c) the SSE profile still has known
spec/reference-implementation divergences (stream routing of `session/load` results, unknown-
session GET behavior, cookie affinity) that are slated for the RFD's hardening phase. The
HTTP+SSE client profile follows once those settle.

### 3. The runner gateway (serving side)

The runner **wraps existing ACP agent servers, not the underlying agent binaries** — the same
adapters spawned locally today become the processes behind a gateway. Per-agent knowledge
stays in the adapters; any custom ACP agent deploys to the runner as just another registry
entry; the gateway needs zero agent-specific code.

It is an ACP-*aware* gateway rather than a byte pipe, because the runner is the only process
positioned to provide:

- **Workspace materialization** — `cwd`, worktrees, and checkouts are runner-filesystem
  concepts; the runner validates/rewrites `session/new` paths against the
  [workspace model](workspace-model.md) instead of exposing its whole disk.
- **Per-principal authorization** — sessions bind to the authenticated caller, and
  `load`/`resume`/`fork` check ownership. (The reference implementation's single shared-secret
  model authorizes any token holder to load any session — a model to explicitly not copy for
  multi-tenant deployments.)
- **Runner-side MCP injection** — rewriting `mcpServers` on `session/new` to runner-local
  endpoints, which is where remote structured-output capture lives (below).
- **Adapter-lifetime decoupling** — keeping an adapter process alive across a dropped
  connection so an in-flight turn survives a network partition, then re-attaching on
  reconnect. This generalizes the existing `resumeInBackground` behavior from deliberate
  detach to involuntary disconnect.

The serving-side aggregation and backend-selection contract is defined in
[`acp-server.md`](acp-server.md): clients negotiate the AgentPrism routing extension on a discovery
connection, then pin each operational ACP connection to one allowlisted backend during `initialize`.
Spawn commands and environment secrets never reach the client.

**Packaging:** the runner ships as its own package, `@automatalabs/acp-server` — named by the
protocol surface it exposes, mirroring `@automatalabs/mcp-server` (the adapters it fronts are
themselves ACP servers; this is the one remote clients connect to). One namespaced bin
(`agentprism-acp-server`) designed for npx-driven provisioning — a fresh machine with only
Node installed bootstraps with a single command:

```bash
npx -y @automatalabs/acp-server start   # install + daemonize + print "wss://<host>:<port>/acp" + token
npx -y @automatalabs/acp-server stop    # graceful drain, then shutdown
npx -y @automatalabs/acp-server status | logs -f | token [--rotate] | doctor
npx -y @automatalabs/acp-server run     # foreground mode, for Docker/systemd/Fly-style supervisors
```

`start` self-daemonizes (detached child, pidfile + state + logs under `~/.agentprism/acp-server/`)
and waits for the daemon's health endpoint before exiting, so scripted installs return only
when the runner is accepting connections. The control plane is deliberately dumb — pidfile +
signals, not RPC — so a newer npx-resolved CLI can always stop an older running daemon
(upgrades are `stop` + `start`). The runner reuses the same backend-registry shape and
`AGENTPRISM_BACKENDS` env var as local config, with built-in adapter entries defaulting to
npx-based spawns so adapters are fetched on demand; `doctor` reports what npx cannot solve
(agent credentials on the box, TLS/tunnel fronting). A generated auth token is mandatory
whenever binding beyond loopback.

### 4. Structured output over remote, in three phases

The `StructuredOutput` tool host is currently a localhost HTTP MCP server inside the engine
process — in-process capture, which a remote agent cannot reach across NAT/firewalls.
Sequenced fix:

1. **Day one:** remote backends fall back to the prompt/`_meta` structured-output path
   (already exists as `structuredOutputTool: false`).
2. **With our runner:** runner-side capture — the injected server runs next to the agent and
   the runner forwards captured payloads over the connection it already holds.
3. **Endgame:** [MCP-over-ACP](https://agentclientprotocol.com/rfds/mcp-over-acp) tunnels the
   agent's MCP traffic back over the ACP connection itself (`mcp/connect`/`mcp/message`),
   restoring in-process capture with no topology assumptions. Tracked on the
   [ACP v2 watch list](acp-v2-readiness.md).

### 5. Durability model

Under ACP v1 the transport replays nothing: sessions survive disconnects server-side, but
updates emitted while disconnected are lost. Engine reconnect logic must therefore treat the
journal as potentially gappy after any drop and reconcile via `session/load` replay. ACP v2's
transport durability (event IDs, `Last-Event-ID` resumption, defined reconnect semantics)
later reduces that to replaying the missed tail. Reconnect, backoff, and liveness are
explicitly the implementer's job in v1 — they belong in `acp-agents`, invisible to
integrators.

## Sequencing

1. **Spike:** drive a `goose serve` instance (the RFD's reference server) over WS from an
   AgentRunner behind a config flag — validates the transport seam against real
   infrastructure before any server-side work, and incidentally makes Goose a drivable
   backend.
2. Remote backend config union + reconnect/`session/load` reconciliation in `acp-agents`.
3. Runner gateway (WS-only server first) with per-principal auth and runner-side registry.
4. Runner-side structured-output capture; HTTP+SSE client profile once the RFD hardening
   phase lands.

## Open questions

- Auth token shape for the runner (static bearer vs. short-lived minted tokens) and how it
  composes with the existing ACP auth-method machinery.
- Whether the pool should multiplex multiple sessions over one WS connection per backend
  (the protocol allows it) or keep connection-per-run for isolation.
