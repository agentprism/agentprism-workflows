/**
 * Request validation for the loopback daemon, applied before any transport dispatch.
 *
 * The Streamable HTTP spec (2025-11-25) requires Origin validation on all incoming
 * connections (403 on invalid) to prevent DNS-rebinding attacks; SDK 1.29 deprecated its
 * built-in `allowedOrigins`/`enableDnsRebindingProtection` options in favor of exactly this
 * kind of external middleware. Host validation is the rebinding defense-in-depth: a rebound
 * hostname shows up in the Host header and is rejected even though the socket is loopback.
 */

import type { IncomingHttpHeaders } from "node:http";

import { DAEMON_ALLOWED_ORIGINS_ENV } from "./constants.js";

export type RequestVerdict = { ok: true } | { ok: false; status: number; message: string };

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parseAuthority(value: string): URL | undefined {
  try {
    return new URL(`http://${value}`);
  } catch {
    return undefined;
  }
}

function extraAllowedOrigins(env: Record<string, string | undefined>): Set<string> {
  const raw = env[DAEMON_ALLOWED_ORIGINS_ENV];
  if (raw === undefined) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  );
}

export function validateRequest(
  headers: IncomingHttpHeaders,
  boundPort: number,
  env: Record<string, string | undefined> = process.env,
): RequestVerdict {
  const host = typeof headers.host === "string" ? headers.host : undefined;
  if (host === undefined) {
    return { ok: false, status: 403, message: "Forbidden: missing Host header" };
  }
  const authority = parseAuthority(host);
  if (authority === undefined || !LOOPBACK_HOSTNAMES.has(authority.hostname)) {
    return { ok: false, status: 403, message: "Forbidden: invalid Host" };
  }
  const hostPort = authority.port === "" ? "80" : authority.port;
  if (hostPort !== String(boundPort)) {
    return { ok: false, status: 403, message: "Forbidden: invalid Host port" };
  }

  const origin = typeof headers.origin === "string" ? headers.origin : undefined;
  if (origin === undefined) return { ok: true }; // Non-browser clients (shim, Codex, Claude Code) send none.
  if (extraAllowedOrigins(env).has(origin)) return { ok: true };
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return { ok: false, status: 403, message: "Forbidden: invalid Origin" };
  }
  if (parsedOrigin.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsedOrigin.hostname)) {
    return { ok: true };
  }
  return { ok: false, status: 403, message: "Forbidden: origin not allowed" };
}
