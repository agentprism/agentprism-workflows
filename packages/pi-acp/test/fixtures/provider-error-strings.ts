export const FIXTURE_PI_PIN = "0.84.3";
// 2026-08-25 bump 0.84.2 -> 0.84.3: the release adds PowerShell, model/thinking controls,
// compaction events, and provider/runtime fixes. AgentSession.setModel now keeps selection
// session-scoped unless persistence is explicitly requested, which matches pi-acp's per-session
// model configuration. The steering/follow-up SDK methods and the error-classification surface are
// unchanged. E1 re-verified against the installed v0.84.3 dists: auth-guidance.js is byte-identical;
// agent-session.js still emits the same "Authentication failed for" / "Run '/login" /
// "to re-authenticate" templates; and pi-ai dist/utils/{retry,overflow,error-body,provider-retry}.js
// are byte-identical to 0.84.2. The fixture strings therefore remain byte-identical.
// 2026-08-17 bump 0.84.1 -> 0.84.2: a no-breaking-changes patch (fullscreen transcript search,
// configurable default tools, a native Mistral Chat Completions transport, plus TUI /
// provider-stream and JSON/RPC usage-streaming fixes) that touches no classified surface. E1
// re-verified against the installed pi v0.84.2 dists: auth-guidance.js still emits `No API key
// found for ${providerDisplay}.` over `getProviderLoginHelp()`, and agent-session.js still carries
// the "Authentication failed for" / "Run '/login" / "to re-authenticate" prose the classifier keys
// on; pi-ai's retry/overflow/error-body/provider-retry util dists are unchanged, so the
// provider-error fixtures below classify byte-identically. Only the pin moves.
// 2026-08-07 bump 0.84.0 -> 0.84.1: a no-breaking-changes patch (additive Qwen provider,
// `pi auth check`, fullscreen mouse/scroll, extension tool_call `terminate`, plus TUI/Bun/LaTeX
// fixes) that touches no classified surface. E1 re-verified against the installed pi v0.84.1
// dists — the auth guidance strings and provider-error prose below classify byte-identically, so
// only the pin moves.
// 2026-08-06 bump 0.83.0 -> 0.84.0: re-verified against the installed pi v0.84.0 dists. Three
// auth strings moved from literal `"anthropic"` forms to `${provider}` template literals
// (dist/core/agent-session.js, auth-guidance.js), but the classifier matches the stable
// substrings those templates resolve to ("no api key found", "authentication failed for",
// "run '/login") — captured at errors.ts — so E1's classification expectations are unchanged.
// Only the pin moves; E1's prose fixtures remain the regression baseline for our classifier.
// 2026-08-03 bump 0.82.1 -> 0.83.0: every fixture string below was re-verified byte-identical
// against the installed pi v0.83.0 dists — dist/core/auth-guidance.js diffs clean against the
// 0.82.1 tarball, the auth strings still span the concatenated template literals at
// dist/core/agent-session.js:186,852, and pi-ai's dist/utils/{retry,overflow,error-body,
// provider-retry}.js are byte-identical to 0.82.1 (0.83.0's error-surface changes — raw
// provider stop reasons and the "pending" StopReason — live in the stream layer, not in the
// classified prose); the per-string citations record where each originated at v0.80.10.
// 2026-07-25 bump 0.82.0 -> 0.82.1: every fixture string below was re-verified byte-identical
// against the installed pi v0.82.1 dists — the guidance templates reconstructed from
// dist/core/auth-guidance.js, the auth strings still spanning concatenated template literals
// at dist/core/agent-session.js:186,852, and the provider-error values unchanged because
// pi-ai's dist/utils/retry.js and dist/utils/overflow.js are byte-identical to 0.82.0
// (its only 0.82.1 error change guards unread response streams in dist/utils/error-body.js);
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
