# `@automatalabs/acp-server` Agent Instructions

Root monorepo, delivery, attribution, compatibility, and release rules always apply.

## Package scope

This package is the ACP V1 stdio composition root defined by
[`docs/roadmap/acp-server.md`](../../docs/roadmap/acp-server.md). It owns only the AgentPrism router
capability, discovery connection, backend selection during operational `initialize`, and the
connection-pinned transparent proxy. Keep workflow execution and backend-specific protocol behavior
out of this package.

Operational connections preserve the selected backend's ACP messages, `_meta`, and session IDs.
Do not add session routing tables, synthetic model catalogs, backend fallbacks, authentication,
authorization, workspace policy, or protocol-era compatibility layers.

## Test Authoring Guidelines

No tautological tests. Tautological tests are harmful, and should never be added.

If you encounter a tautological test, remove it.

For acp-server, tests should not be testing the underlying protocol or underlying acp servers. They should be focused on our agentprism-specific additions to the protocol. By virtue, that means the test suite will be relatively minimal. Do not author tests that are not relevant to our implementation.
