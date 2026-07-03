import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAgentRunner, type AcpRunnerOptions } from "../../src/index.js";

export const FAKE_AGENT_FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));

export const TEST_ENV_VARS = [
  "AGENTPRISM_CLAUDE_ACP_CMD",
  "AGENTPRISM_CLAUDE_ACP_ARGS",
  "AGENTPRISM_CODEX_ACP_CMD",
  "AGENTPRISM_CODEX_ACP_ARGS",
  "AGENTPRISM_FAKE_LOG",
  "AGENTPRISM_FAKE_SCENARIO",
  "AGENTPRISM_FAKE_CRASH_SENTINEL",
  "AGENTPRISM_DEFAULT_BACKEND",
] as const;

type FakeBackend = "claude" | "codex";

export interface FakeAgentConfigureOptions {
  /** Prefix for the per-test temp worktree/log directory. */
  prefix?: string;
  /** Built-in spawn overrides to point at the fake. Defaults to both built-ins. */
  backends?: readonly FakeBackend[];
  /** Whether to create AGENTPRISM_FAKE_CRASH_SENTINEL in the temp dir. */
  crashSentinel?: boolean;
  /** Optional default backend env for routing tests. */
  defaultBackend?: string;
  /** Extra env vars to set after the fake-agent env. `undefined` deletes the key. */
  env?: Record<string, string | undefined>;
}

export interface FakeAgentConfig<TLogEntry> {
  cwd: string;
  log: string;
  readLog: () => TLogEntry[];
}

export interface Disposable {
  dispose(): Promise<void>;
}

export interface FakeAgentHarnessOptions extends FakeAgentConfigureOptions {
  runnerOptions?: AcpRunnerOptions;
}

export function configure<TLogEntry = { method: string }>(
  scenario: unknown,
  options: FakeAgentConfigureOptions = {},
): FakeAgentConfig<TLogEntry> {
  const dir = mkdtempSync(path.join(tmpdir(), options.prefix ?? "acp-it-"));
  const log = path.join(dir, "log.jsonl");
  const backends = options.backends ?? ["claude", "codex"];
  if (backends.includes("claude")) {
    process.env.AGENTPRISM_CLAUDE_ACP_CMD = process.execPath;
    process.env.AGENTPRISM_CLAUDE_ACP_ARGS = FAKE_AGENT_FIXTURE;
  }
  if (backends.includes("codex")) {
    process.env.AGENTPRISM_CODEX_ACP_CMD = process.execPath;
    process.env.AGENTPRISM_CODEX_ACP_ARGS = FAKE_AGENT_FIXTURE;
  }
  process.env.AGENTPRISM_FAKE_LOG = log;
  process.env.AGENTPRISM_FAKE_SCENARIO = JSON.stringify(scenario);
  if (options.crashSentinel) {
    process.env.AGENTPRISM_FAKE_CRASH_SENTINEL = path.join(dir, "crash.sentinel");
  }
  if (options.defaultBackend !== undefined) {
    process.env.AGENTPRISM_DEFAULT_BACKEND = options.defaultBackend;
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return { cwd: dir, log, readLog: () => readLog<TLogEntry>(log) };
}

export function readLog<TLogEntry>(log: string): TLogEntry[] {
  if (!existsSync(log)) return [];
  const content = readFileSync(log, "utf8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TLogEntry);
}

export function resetFakeAgentEnv(keys: readonly string[] = TEST_ENV_VARS): void {
  for (const key of keys) delete process.env[key];
}

export function createFakeAgentHarness(defaults: FakeAgentHarnessOptions = {}): {
  configure: <TLogEntry = { method: string }>(
    scenario: unknown,
    options?: FakeAgentConfigureOptions,
  ) => FakeAgentConfig<TLogEntry>;
  makeRunner: (options?: AcpRunnerOptions) => AcpAgentRunner;
  track: <T extends Disposable>(disposable: T) => T;
  cleanup: () => Promise<void>;
} {
  const disposables: Disposable[] = [];
  return {
    configure: <TLogEntry = { method: string }>(
      scenario: unknown,
      options: FakeAgentConfigureOptions = {},
    ): FakeAgentConfig<TLogEntry> =>
      configure<TLogEntry>(scenario, {
        ...defaults,
        ...options,
        env: { ...(defaults.env ?? {}), ...(options.env ?? {}) },
      }),
    makeRunner: (options: AcpRunnerOptions = defaults.runnerOptions ?? {}): AcpAgentRunner => {
      const runner = new AcpAgentRunner(options);
      disposables.push(runner);
      return runner;
    },
    track: <T extends Disposable>(disposable: T): T => {
      disposables.push(disposable);
      return disposable;
    },
    cleanup: async (): Promise<void> => {
      await Promise.all(disposables.splice(0).map((disposable) => disposable.dispose()));
      resetFakeAgentEnv();
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds (deterministic vs. fixed delays whose timing depends on spawn). */
export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await delay(10);
  }
}

export function withTimeout<T>(promise: Promise<T>, ms = 2500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
