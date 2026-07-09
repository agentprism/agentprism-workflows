// The auth lifecycle spine (§2): the runner's single `AuthStore`, its per-`poolKey`
// `BackendAuthMachine` (generation-stamped state machine), the immutable `AuthIntent` that is the
// ONLY home for credential material in the library, and the connection-level `ConnectionAuthStamp`.
//
// Correctness ("no session is ever served under stale auth") is a LOCAL, mechanical property
// enforced by a monotonic generation counter (§2.3), not by bookkeeping: a single completed auth
// (`host_authenticate`) or `logout` bumps `generation`, which atomically invalidates every existing
// connection's stamp. `intentView()`/`AuthStatusSnapshot` expose only ids/types/klass — never the
// secret `authenticateMeta`/`envValues` (§2.14, Principle 9).
import type { AuthMethod } from "@agentclientprotocol/sdk";
import type { AuthProfile } from "./auth-profiles.js";
import { isGatewayShapedMeta } from "./auth-types.js";

export type AuthMethodType = "agent" | "terminal" | "env_var";

/** The three-value strategy that collapses onto the two credential classes (§2.1):
 *   "disk"       -> disk-persisted; apply on a fresh connection = NOTHING.
 *   "in-process" -> per-spawn via authenticate RPC replay (§2.5).
 *   "spawn-env"  -> per-spawn via env injection + recycle (§2.8). */
export type CredentialClass = "disk" | "in-process" | "spawn-env";

/** Type-driven, agent-agnostic classification (§2.1). Keys ONLY on the method type + whether the
 *  advertised `_meta` is gateway-shaped — never on an agent id. */
export function classifyCredential(
  methodType: AuthMethodType,
  advertisedMeta: Record<string, unknown> | null | undefined,
): { klass: CredentialClass; diskBacked: boolean } {
  switch (methodType) {
    case "env_var":
      return { klass: "spawn-env", diskBacked: false };
    case "terminal":
      return { klass: "disk", diskBacked: true };
    case "agent":
      return isGatewayShapedMeta(advertisedMeta)
        ? { klass: "in-process", diskBacked: false }
        : { klass: "disk", diskBacked: true };
  }
}

/** The host's completed auth choice, recorded as ONE immutable intent. This is the only place
 *  credential material lives in the library — never written to a journal, emitted in an event, or
 *  logged (§2.14). */
export interface AuthIntent {
  readonly backendId: string;
  readonly poolKey: string;
  readonly methodId: string;
  readonly methodType: AuthMethodType;
  readonly klass: CredentialClass;
  /** SECRET. The `_meta` payload for the chosen method (e.g. claude `{ gateway: { baseUrl, headers } }`
   *  or codex `{ "api-key": { apiKey } }`). Populated for BOTH in-process and disk intents; how it is
   *  consumed depends on `klass`, not on whether it is set. */
  readonly authenticateMeta?: Record<string, unknown>;
  /** SECRET; spawn-env only. Env values injected at agent spawn. */
  readonly envValues?: Record<string, string>;
  /** klass === "disk": a fresh process re-reads the native store; survives cold resume (§2.13). */
  readonly diskBacked: boolean;
}

/** The connection-level record of which intent-generation THIS process reflects (§2.4). */
export interface ConnectionAuthStamp {
  appliedGeneration: number;
  applied: boolean;
  trippedAuthRequired: boolean;
}

export type BackendAuthState = "unauthenticated" | "credentials_held" | "authenticated" | "auth_required";

export type AuthEvent =
  | { t: "initialize_ok"; connectionId: string; advertised: readonly AuthMethod[] }
  | { t: "host_authenticate"; intent: AuthIntent }
  | { t: "apply_ok"; connectionId: string; generation: number }
  | { t: "apply_failed"; connectionId: string; generation: number; error: unknown }
  | { t: "auth_required_tripped"; connectionId: string; error: unknown }
  | { t: "logout" }
  | { t: "process_death"; connectionId: string };

/** Redacted, secret-free projection of an intent — ids/types/klass only (§2.14). */
export type RedactedIntent = Readonly<Omit<AuthIntent, "authenticateMeta" | "envValues">>;

/** Best-effort in-place zeroization of an intent's secret payload before it is dropped (§2.14). The
 *  intent's `readonly` typing is a compile-time contract, not a runtime freeze, so we overwrite. */
function zeroizeIntent(intent: AuthIntent): void {
  const meta = intent.authenticateMeta;
  if (meta) for (const key of Object.keys(meta)) delete meta[key];
  const env = intent.envValues;
  if (env) for (const key of Object.keys(env)) env[key] = "";
}

/** One state machine per `poolKey`, owned by the `AuthStore`. The single source of auth truth. */
export class BackendAuthMachine {
  private _state: BackendAuthState = "unauthenticated";
  private _generation = 0;
  private _intent: AuthIntent | undefined;
  private _advertised: readonly AuthMethod[] = [];

  get state(): BackendAuthState {
    return this._state;
  }

  get generation(): number {
    return this._generation;
  }

  /** The advertised methods most recently observed at `initialize` (redaction source for status). */
  get advertised(): readonly AuthMethod[] {
    return this._advertised;
  }

  get authenticated(): boolean {
    return this._state === "authenticated";
  }

  /** Redacted view — ids/types/klass only, NEVER authenticateMeta/envValues. */
  intentView(): RedactedIntent | undefined {
    if (!this._intent) return undefined;
    const { authenticateMeta: _m, envValues: _e, ...rest } = this._intent;
    return rest;
  }

  /** SECRET accessor — connection-internal only (used by applyAuthIntent, §2.5). */
  applyMeta(): Record<string, unknown> | undefined {
    return this._intent?.authenticateMeta;
  }

  /** SECRET accessor — pool/connection-internal only (used by spawnEnvFor, §2.8). */
  spawnEnv(): Record<string, string> | undefined {
    return this._intent?.envValues;
  }

  /** SECRET accessor — module-internal only (AuthStore.spawnEnvFor passes it to a profile). */
  rawIntent(): AuthIntent | undefined {
    return this._intent;
  }

  /** Cold-resume re-arm predicate (§2.13): resumable iff creds are held/applied OR disk-backed. */
  canResume(): boolean {
    if (this._state === "authenticated" || this._state === "credentials_held") return true;
    return this._intent?.diskBacked === true;
  }

  isStale(stamp: ConnectionAuthStamp): boolean {
    return stamp.appliedGeneration < this._generation;
  }

  /** true iff the current intent is an in-process (gateway) cred that can be live-re-applied on an
   *  idle connection via an authenticate RPC replay, rather than requiring a process recycle. */
  currentKlassIsInProcess(): boolean {
    return this._intent?.klass === "in-process";
  }

  send(ev: AuthEvent): void {
    switch (ev.t) {
      case "initialize_ok":
        this._advertised = ev.advertised;
        return;
      case "host_authenticate":
        // The only events that bump `generation` are host_authenticate and logout, so one completed
        // auth atomically invalidates every existing connection's stamp (§2.3).
        this._intent = ev.intent;
        this._generation += 1;
        this._state = "credentials_held";
        return;
      case "apply_ok":
        if (this._state === "credentials_held") this._state = "authenticated";
        return;
      case "apply_failed":
        if (this._state === "credentials_held" || this._state === "authenticated") {
          this._state = "auth_required";
        }
        return;
      case "auth_required_tripped":
        // unauthenticated / auth_required / authenticated -> auth_required (mid-run expiry included).
        this._state = "auth_required";
        return;
      case "logout":
        if (this._intent) zeroizeIntent(this._intent);
        this._intent = undefined;
        this._generation += 1;
        this._state = "unauthenticated";
        return;
      case "process_death":
        // The dying connection's stamp is dropped with it; machine state is unchanged (§2.3).
        return;
    }
  }
}

/** The single per-runner auth store. Owns one `BackendAuthMachine` per `poolKey` and records the
 *  (optional) per-backend `AuthProfile` so `spawnEnvFor` can consult it. */
export class AuthStore {
  private readonly machines = new Map<string, BackendAuthMachine>();
  private readonly profiles = new Map<string, AuthProfile | undefined>();

  /** Get/create the machine for a `poolKey`, recording the backend's profile the first time. */
  machineFor(poolKey: string, profile?: AuthProfile): BackendAuthMachine {
    let machine = this.machines.get(poolKey);
    if (!machine) {
      machine = new BackendAuthMachine();
      this.machines.set(poolKey, machine);
    }
    if (profile && !this.profiles.has(poolKey)) this.profiles.set(poolKey, profile);
    return machine;
  }

  /** The machine for a `poolKey`, or undefined if none has been created yet (read-only lookup). */
  existing(poolKey: string): BackendAuthMachine | undefined {
    return this.machines.get(poolKey);
  }

  /** Every `poolKey` that has a machine (the touched backends). */
  poolKeys(): string[] {
    return [...this.machines.keys()];
  }

  /** The spawn-env overlay (§2.8): the machine's `env_var` collected values merged with the backend
   *  profile's `spawnAuthEnv(intent)` contribution. Undefined when neither applies. Secret — passed
   *  straight to `spawn`, never logged. */
  spawnEnvFor(poolKey: string): Record<string, string> | undefined {
    const machine = this.machines.get(poolKey);
    if (!machine) return undefined;
    const envValues = machine.spawnEnv();
    const profile = this.profiles.get(poolKey);
    const intent = machine.rawIntent();
    const profileEnv = profile?.spawnAuthEnv && intent ? profile.spawnAuthEnv(intent) : undefined;
    if (!envValues && !profileEnv) return undefined;
    return { ...(envValues ?? {}), ...(profileEnv ?? {}) };
  }
}

/** Strip credential-shaped substrings from best-effort diagnostic text (stderr tails, §2.14). Never
 *  the machine-readable channel — a defensive scrub so a spawned agent that echoes an injected env
 *  var to stderr cannot leak it into an error suffix. */
const SECRET_LINE_PATTERNS: RegExp[] = [
  /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|AWS_[A-Za-z0-9_]+|CODEX_API_KEY|CODEX_ACCESS_TOKEN|CODEX_AUTH|OPENCODE_AUTH_CONTENT|DEFAULT_AUTH_REQUEST)(\s*[:=]\s*)(\S.*)$/,
];
const SECRET_INLINE_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  { re: /\b([A-Za-z_][A-Za-z0-9_]*_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENCODE_AUTH_CONTENT)(=)(\S+)/g, replace: "$1=[redacted]" },
  // Bearer tokens / Authorization header values.
  { re: /\b(Bearer|Authorization:?\s*Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, replace: "$1 [redacted]" },
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .split("\n")
    .map((line) => {
      for (const re of SECRET_LINE_PATTERNS) {
        const m = line.match(re);
        if (m) return `${m[1]}${m[2]}${m[3]}[redacted]`;
      }
      let out = line;
      for (const { re, replace } of SECRET_INLINE_PATTERNS) out = out.replace(re, replace);
      return out;
    })
    .join("\n");
}
