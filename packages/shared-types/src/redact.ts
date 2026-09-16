// ===== packages/shared-types/src/redact.ts =====
// Credential redaction and code-point-safe UTF-8 truncation shared by every layer that projects
// text toward a host (workflow-engine observability, the workflows CLI, mcp-server, acp-agents).
// This module must stay free of Node globals: shared-types is imported by the browser UI.

const TRUNCATED_SUFFIX = "…[truncated]";

const SENSITIVE_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|credential|authorization|cookie|private[_-]?key)[A-Za-z0-9_.-]*)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const PEM_PRIVATE_KEY = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;
const AUTH_CREDENTIAL = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi;
const URL_USER_INFO = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const JWT = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
const KNOWN_CREDENTIAL =
  /(?<![A-Za-z0-9_-])(?:github_pat_|sk-proj-|ghp_|gho_|ghu_|ghs_|xoxb-|xoxp-|sk-|AKIA|ASIA)[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;
const OPAQUE_TOKEN =
  /(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-]))(?=[A-Za-z0-9+/_=-]*[A-Za-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/g;

function replaceAndTrack(value: string, pattern: RegExp, replacement: string | ((...args: string[]) => string)) {
  let changed = false;
  const output = value.replace(pattern, (...args: string[]) => {
    changed = true;
    return typeof replacement === "string" ? replacement : replacement(...args);
  });
  return { output, changed };
}

/** Redact credential-shaped text without offering a raw escape hatch. */
export function redactText(value: string): { value: string; redacted: boolean } {
  let output = value;
  let redacted = false;
  const apply = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
    const result = replaceAndTrack(output, pattern, replacement);
    output = result.output;
    redacted ||= result.changed;
  };

  apply(PEM_PRIVATE_KEY, "[REDACTED]");
  apply(AUTH_CREDENTIAL, "[REDACTED]");
  apply(URL_USER_INFO, (_match, scheme) => `${scheme}[REDACTED]@`);
  apply(JWT, "[REDACTED]");
  apply(SENSITIVE_ASSIGNMENT, (_match, key, separator) => `${key}${separator}[REDACTED]`);
  apply(KNOWN_CREDENTIAL, "[REDACTED]");
  apply(OPAQUE_TOKEN, "[REDACTED]");
  return { value: output, redacted };
}

// WHATWG TextEncoder rather than a Node-only byte counter so this stays runnable in a browser; the two agree
// byte-for-byte on every string (lone surrogates encode as U+FFFD, three bytes, in both).
const utf8 = new TextEncoder();
const byteLength = (value: string): number => utf8.encode(value).length;

/** Shorten UTF-8 text without splitting a Unicode code point. */
export function truncateUtf8(value: string, maxBytes: number, suffix = TRUNCATED_SUFFIX): string {
  if (byteLength(value) <= maxBytes) return value;
  const suffixBytes = byteLength(suffix);
  if (suffixBytes >= maxBytes) {
    let shortSuffix = "";
    for (const point of suffix) {
      if (byteLength(shortSuffix + point) > maxBytes) break;
      shortSuffix += point;
    }
    return shortSuffix;
  }
  let kept = "";
  for (const point of value) {
    if (byteLength(kept + point) + suffixBytes > maxBytes) break;
    kept += point;
  }
  return kept + suffix;
}
