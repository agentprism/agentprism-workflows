# @automatalabs/acp-server

## 0.2.20

### Patch Changes

- 3c2f672: Move to `@agentclientprotocol/sdk@^1.5.0` (ACP schema 1.23.0).

  The schema adds one UNSTABLE session update, `notice` — a fire-and-forget advisory (`severity`, `title`, optional `description`) an agent may send only to a client that advertises `clientCapabilities.session.notices`. AgentPrism does not advertise it, so no built-in agent sends one. Because event names are the ACP `sessionUpdate` discriminants verbatim, `notice` is now a typed event name on the runner and `AcpAgent` event buses and reaches the `session_update` catch-all like every other kind; the workflow activity projection counts it as backend activity, the same as the other non-content updates.

  The schema also stabilizes the tool-call `name` field (`ToolCall.name` / `ToolCallUpdate.name`), which AgentPrism already prefers for tool-policy matching. No request, response, or capability shape AgentPrism sends or reads changed.

- Updated dependencies [3c2f672]
- Updated dependencies [3c2f672]
  - @automatalabs/acp-agents@3.3.0

## 0.2.19

### Patch Changes

- Updated dependencies [21bb2ca]
  - @automatalabs/acp-agents@3.2.1

## 0.2.18

### Patch Changes

- Updated dependencies [71ab48d]
  - @automatalabs/acp-agents@3.2.0

## 0.2.17

### Patch Changes

- Updated dependencies [4618813]
  - @automatalabs/acp-agents@3.1.0

## 0.2.16

### Patch Changes

- Updated dependencies [3b9e249]
  - @automatalabs/acp-agents@3.0.2

## 0.2.15

### Patch Changes

- Updated dependencies [f6dddc1]
  - @automatalabs/acp-agents@3.0.1

## 0.2.14

### Patch Changes

- Updated dependencies [76bbf8f]
  - @automatalabs/acp-agents@3.0.0

## 0.2.13

### Patch Changes

- Updated dependencies [5311099]
  - @automatalabs/acp-agents@2.0.0

## 0.2.12

### Patch Changes

- Updated dependencies [07505a3]
  - @automatalabs/acp-agents@1.3.0

## 0.2.11

### Patch Changes

- Updated dependencies [82fc72e]
  - @automatalabs/acp-agents@1.2.7

## 0.2.10

### Patch Changes

- @automatalabs/acp-agents@1.2.6

## 0.2.9

### Patch Changes

- Updated dependencies [efe2c6e]
  - @automatalabs/acp-agents@1.2.5

## 0.2.8

### Patch Changes

- Updated dependencies [3448db1]
  - @automatalabs/acp-agents@1.2.4

## 0.2.7

### Patch Changes

- @automatalabs/acp-agents@1.2.3

## 0.2.6

### Patch Changes

- @automatalabs/acp-agents@1.2.2

## 0.2.5

### Patch Changes

- Updated dependencies [6005ed8]
  - @automatalabs/acp-agents@1.2.1

## 0.2.4

### Patch Changes

- Updated dependencies [b098a93]
  - @automatalabs/acp-agents@1.2.0

## 0.2.3

### Patch Changes

- @automatalabs/acp-agents@1.1.3

## 0.2.2

### Patch Changes

- Updated dependencies [18561da]
  - @automatalabs/acp-agents@1.1.2

## 0.2.1

### Patch Changes

- Updated dependencies [3a3932c]
  - @automatalabs/acp-agents@1.1.1

## 0.2.0

### Minor Changes

- 59c3888: Add an HTTP mode that serves ACP V1 over Streamable HTTP and WebSocket, backed by the official TypeScript SDK transport adapters, while retaining stdio as the default.

## 0.1.0

### Minor Changes

- 58b4a86: Add the AgentPrism ACP server package with negotiated discovery connections, connection-pinned backend proxying, transparent ACP V1 traffic forwarding, and shared raw backend-process access from acp-agents.

### Patch Changes

- Updated dependencies [58b4a86]
  - @automatalabs/acp-agents@1.1.0
