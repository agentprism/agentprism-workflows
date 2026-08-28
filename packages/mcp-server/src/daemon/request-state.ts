import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { workflowHomeDir } from "@automatalabs/workflows";

interface StoredRequestStateKey {
  version: 1;
  key: string;
}

export function requestStateKeyPath(fingerprint: string): string {
  return join(workflowHomeDir(), "daemons", `${fingerprint}.request-state-key.json`);
}

function decodeStoredKey(path: string): Uint8Array {
  let parsed: Partial<StoredRequestStateKey>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredRequestStateKey>;
  } catch (error) {
    throw new Error(`Unable to read the daemon requestState key at ${path}: ${String(error)}`);
  }
  if (parsed.version !== 1 || typeof parsed.key !== "string") {
    throw new Error(`Invalid daemon requestState key file at ${path}`);
  }
  const key = Buffer.from(parsed.key, "base64");
  if (key.byteLength !== 32) throw new Error(`Invalid daemon requestState key length at ${path}`);
  chmodSync(path, 0o600);
  return key;
}

/**
 * Load or atomically create the daemon-family HMAC key. Successor daemons use the same key,
 * so an integrity-protected input_required round survives process replacement without ever
 * accepting unverified client state. Malformed key files fail closed and are never replaced.
 */
export function loadOrCreateRequestStateKey(fingerprint: string): Uint8Array {
  const path = requestStateKeyPath(fingerprint);
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  const stored: StoredRequestStateKey = { version: 1, key: key.toString("base64") };
  try {
    writeFileSync(path, `${JSON.stringify(stored)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return decodeStoredKey(path);
  }
}
