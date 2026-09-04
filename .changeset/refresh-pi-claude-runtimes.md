---
"@automatalabs/acp-agents": patch
"@automatalabs/pi-acp": patch
---

Update Claude's ACP adapter to 0.74.0 and the wrapped Claude Agent SDK to 0.3.261. The adapter validates supplied gateway URLs and adds opt-in subscription restrictions; existing host routing and permission behavior remain unchanged.

Update the Pi runtime and matching agent-core fixture dependency to 0.85.0. This brings provider-stream fixes, compaction-aware idle/cancellation, and corrected fork compaction boundaries while preserving the integration's session/config API. Reverify provider-error guidance and pause/retry classifications against the published runtime.

Declare the Pi server runtime imported by the SDK but omitted from its upstream dependency metadata, and include it in dependency freshness checks. Verify the packed adapter's public import in clean npm and pnpm installations.
