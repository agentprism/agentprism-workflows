import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { workflowHomeDir } from "@automatalabs/workflows";

export const RUN_CONTROL_PATH = "/_agentprism/control/v1/run";
export const RUN_CONTROL_PROTOCOL = 1 as const;
export const RUN_CONTROL_MAX_CLOCK_SKEW_MS = 30_000;

interface StoredRunControlKey {
  version: 1;
  key: string;
}

export function runControlKeyPath(): string {
  return join(workflowHomeDir(), "daemons", "run-control-key.json");
}

function decodeStoredKey(path: string): Uint8Array {
  let parsed: Partial<StoredRunControlKey>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredRunControlKey>;
  } catch (error) {
    throw new Error(`Unable to read the daemon run-control key at ${path}: ${String(error)}`);
  }
  if (parsed.version !== 1 || typeof parsed.key !== "string") {
    throw new Error(`Invalid daemon run-control key file at ${path}`);
  }
  const key = Buffer.from(parsed.key, "base64");
  if (key.byteLength !== 32) throw new Error(`Invalid daemon run-control key length at ${path}`);
  chmodSync(path, 0o600);
  return key;
}

/** User-scoped so a daemon in a changed environment family can still control an older run. */
export function loadOrCreateRunControlKey(): Uint8Array {
  const path = runControlKeyPath();
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  const stored: StoredRunControlKey = { version: 1, key: key.toString("base64") };
  try {
    writeFileSync(path, `${JSON.stringify(stored)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return decodeStoredKey(path);
  }
}

function signaturePayload(method: string, path: string, timestamp: string, operationId: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${operationId}\n${bodyHash}`;
}

export interface RunControlAuthHeaders {
  "x-agentprism-control-timestamp": string;
  "x-agentprism-control-operation": string;
  "x-agentprism-control-signature": string;
}

export function signRunControlRequest(
  key: Uint8Array,
  method: string,
  path: string,
  operationId: string,
  body: string,
  now = Date.now(),
): RunControlAuthHeaders {
  const timestamp = String(now);
  const signature = createHmac("sha256", key)
    .update(signaturePayload(method, path, timestamp, operationId, body))
    .digest("hex");
  return {
    "x-agentprism-control-timestamp": timestamp,
    "x-agentprism-control-operation": operationId,
    "x-agentprism-control-signature": signature,
  };
}

export function verifyRunControlRequest(
  key: Uint8Array,
  input: {
    method: string;
    path: string;
    body: string;
    timestamp: string | undefined;
    operationId: string | undefined;
    signature: string | undefined;
    now?: number;
  },
): boolean {
  if (!input.timestamp || !input.operationId || !input.signature) return false;
  const timestamp = Number(input.timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > RUN_CONTROL_MAX_CLOCK_SKEW_MS) return false;
  if (!/^[0-9a-f]{64}$/i.test(input.signature)) return false;
  const expected = createHmac("sha256", key)
    .update(signaturePayload(input.method, input.path, input.timestamp, input.operationId, input.body))
    .digest();
  const actual = Buffer.from(input.signature, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
