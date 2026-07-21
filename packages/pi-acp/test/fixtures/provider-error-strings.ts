export const FIXTURE_PI_PIN = "0.81.0";
// 2026-07-21 bump 0.80.10 -> 0.81.0: every fixture string below was re-verified byte-identical
// against the installed pi v0.81.0 dists (auth/guidance templates moved lines but did not change);
// the per-string citations record where each originated in the pi monorepo at v0.80.10.

const LOGIN_HELP = [
  "Use /login to log into a provider via OAuth or API key. See:",
  "  <DOCS>/providers.md",
  "  <DOCS>/models.md",
].join("\n");

// pi v0.80.10 — packages/coding-agent/src/core/auth-guidance.ts:14-16
export const NO_MODEL_GUIDANCE = `No model selected.\n\n${LOGIN_HELP}\n\nThen use /model to select a model.`;

// pi v0.80.10 — packages/coding-agent/src/core/auth-guidance.ts:18-21
export const NO_API_KEY_GUIDANCE = `No API key found for anthropic.\n\n${LOGIN_HELP}`;

// pi v0.80.10 — packages/coding-agent/src/core/agent-session.ts:411-419
export const OAUTH_REQUEST_AUTH = "Authentication failed for \"anthropic\". Credentials may have expired or network is unavailable. Run '/login anthropic' to re-authenticate.";

// pi v0.80.10 — packages/coding-agent/src/core/agent-session.ts:1170-1182
export const OAUTH_PROMPT_PREFLIGHT = "Authentication failed for \"anthropic\". Credentials may have expired or network is unavailable. Run '/login anthropic' to re-authenticate.";

export const PROVIDER_ERROR_FIXTURES = [
  // pi v0.80.10 — packages/ai/test/retry.test.ts:40-56
  { value: "429 quota exceeded", kind: "billing_error" },
  { value: "overloaded_error", kind: "rate_limit" },
  { value: "524 status code (no body)", kind: "provider_error" },
  // pi v0.80.10 — packages/ai/src/api/pi-messages.ts:124-144 + test/pi-messages.test.ts:177-191
  { value: "401 Unauthorized: Token expired (unauthorized)", kind: "auth_error" },
  // pi v0.80.10 — packages/ai/test/error-body.test.ts:129-146
  { value: 'OpenAI API error (403): {"error":"blocked by gateway WAF"}', kind: "auth_error" },
  { value: 'OpenAI API error (403): {"error":{"message":"Permission denied"}}', kind: "auth_error" },
] as const;
