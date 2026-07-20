---
"@automatalabs/pi-acp": patch
"@automatalabs/acp-agents": patch
"@automatalabs/workflows": patch
"@automatalabs/mcp-server": patch
---

Advertise Pi thinking levels per selected model, reject unrecognized values, and clamp recognized
model gaps through Pi's SDK. Validate workflow thought levels against each call's selected model,
including explicit clamp warnings and safe handling for backends without recognized-domain metadata.
