// Compatibility shim. Built-in profiles live with their backend implementations so onboarding
// has one adapter-owned definition surface while existing source imports remain valid.
export { claudeAuthProfile } from "../backends/claude.js";
export { codexAuthProfile } from "../backends/codex.js";
export { opencodeAuthProfile } from "../backends/opencode.js";
export { piAuthProfile } from "../backends/pi.js";
export type { AuthProfile, TerminalLaunch } from "./auth-profile.js";
