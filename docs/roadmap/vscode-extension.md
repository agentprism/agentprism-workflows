# VS Code extension channel

**Status:** exploring · **Updated:** 2026-07-10

An editor surface for people who live in VS Code — positioned as a **satellite channel**, not a
parallel implementation: it layers on the existing `@automatalabs/mcp-server` and SDK rather
than reimplementing orchestration inside the extension host.

## Grounded constraints (verified against VS Code 1.127)

- **MCP-native integration** is the right seam: VS Code's MCP support (including MCP Apps)
  means the `workflow` tool and checkpoint approvals can surface through the built-in agent UI
  without custom protocol work.
- **Webview architecture** for run observation (journal/progress views) — the standard
  pattern, with the extension process staying thin.
- **No-daemon git triggers**: workspace events (branch switch, commit) can trigger workflow
  suggestions without a background daemon.
- **Open VSX 256 MB package cap** — comfortably fits; no bundling gymnastics needed.

## Sequencing

MCP-first: everything that can ride the MCP server does, so the extension starts as
configuration + surfacing rather than logic. Native extension UI (tree views, checkpoint
cards, journal webview) comes after the MCP path proves the workflows-in-editor loop. Remote
runs later inherit from [remote execution](remote-execution.md) rather than being
extension-specific.

## Open questions

- Whether checkpoint approval lives in the MCP Apps surface or a dedicated webview.
- Distribution: Marketplace + Open VSX from day one, or Marketplace first.
