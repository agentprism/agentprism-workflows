import {RequestError} from "@agentclientprotocol/sdk";

/**
 * Read the optional per-session instruction overrides a client may supply on a session
 * request's `_meta` as bare keys (mirroring the upstream `additionalRoots` convention):
 *
 *   _meta.baseInstructions      -> thread/{start,resume,fork}.baseInstructions
 *   _meta.developerInstructions -> thread/{start,resume,fork}.developerInstructions
 *
 * Read at `session/new` (thread/start), `session/resume` and `session/load` (thread/resume), and
 * `session/fork` (thread/fork) — every request that opens a Codex thread on this connection, so a
 * forked session carries the instructions its `session/fork` request named without a reattach.
 *
 * `baseInstructions` replaces Codex's built-in base system prompt for the thread;
 * `developerInstructions` injects developer-role instructions. An absent key is left
 * unset so Codex keeps its defaults; a present non-string value is rejected. The returned
 * object is spread straight into the Codex thread params, so undefined entries drop out on
 * the wire.
 */
export function readInstructionOverrides(meta?: Record<string, unknown> | null): {
    baseInstructions?: string;
    developerInstructions?: string;
} {
    // Only assign keys that are actually present so spreading them leaves Codex's defaults
    // untouched (and satisfies exactOptionalPropertyTypes).
    const overrides: { baseInstructions?: string; developerInstructions?: string } = {};
    const baseInstructions = readOptionalInstruction(meta, "baseInstructions");
    if (baseInstructions !== undefined) {
        overrides.baseInstructions = baseInstructions;
    }
    const developerInstructions = readOptionalInstruction(meta, "developerInstructions");
    if (developerInstructions !== undefined) {
        overrides.developerInstructions = developerInstructions;
    }
    return overrides;
}

function readOptionalInstruction(
    meta: Record<string, unknown> | null | undefined,
    key: "baseInstructions" | "developerInstructions",
): string | undefined {
    const value = meta?.[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw RequestError.invalidParams(undefined, `${key} must be a string`);
    }
    return value;
}
