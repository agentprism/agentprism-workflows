// Live-backend end-to-end regression test (env-GATED, skip-by-default).
//
// Every OTHER suite in this repo speaks ACP to a FAKE (stub AgentRunner / in-memory
// transport). This one drives the REAL built mcp-server over stdio and the REAL backend
// ACP servers (claude-agent-acp, the de-vendored npm dep codex-acp, and OpenCode), so
// the two structured-output cruxes — (1) a schema'd agent yields a typebox-validated
// structured OBJECT (not text), and (2) ONE long-lived pooled backend subprocess serves
// every session — have a re-runnable guard against the actual adapters.
//
// GATE: it runs ONLY when AGENTPRISM_LIVE_E2E === "1" (and so needs creds + network +
// the backend CLIs). The DEFAULT `pnpm test` leaves it SKIPPED, so the default suite stays
// deterministic and green with no credentials. When gated ON, a backend that cannot
// authenticate makes the assertions FAIL loudly (the diagnostic dump includes the server's
// stderr tail) — it never silently passes.
//
// It is also the acceptance test that the npm-installed @automatalabs/codex-acp fork (NOT the
// old vendor path, and no longer a pnpm patch) drives structured output end to end. OpenCode is
// intentionally not bundled; this live gate requires an installed/authenticated `opencode`.
import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Backend = "claude" | "codex" | "opencode";

// Skip-by-default gate. node:test treats a string `skip` as the skip reason.
const LIVE = process.env.AGENTPRISM_LIVE_E2E === "1";
const SKIP: string | false = LIVE
  ? false
  : "gated live-backend e2e — set AGENTPRISM_LIVE_E2E=1 (with creds) to run";

// The REAL built shell entry (composition root that injects createAcpRunner). `pnpm test`
// builds first; running this suite directly requires a prior `pnpm build`.
const SERVER_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// Resolve the backend ACP server bins exactly as the runner does (createRequire against the
// acp-agents package), so the pooling marker is the SAME node_modules path that will appear
// in the spawned subprocess's argv — and provably an npm install, not a vendored copy.
const requireAcp = createRequire(new URL("../../acp-agents/package.json", import.meta.url));
const BACKEND_BIN: Record<Backend, string> = {
  claude: requireAcp.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"),
  codex: requireAcp.resolve("@automatalabs/codex-acp"),
  opencode: resolveOpenCodeBin(),
};

// Each backend's ACP server is a published npm package under its own scope: Claude stays on the
// upstream @agentclientprotocol adapter; Codex is our patched @automatalabs fork.
const BACKEND_SCOPE: Record<Exclude<Backend, "opencode">, string> = {
  claude: "@agentclientprotocol/",
  codex: "@automatalabs/",
};

const OPENCODE_E2E_MODEL = process.env.AGENTPRISM_OPENCODE_E2E_MODEL ?? "opencode/zai/glm-5.2";

function resolveOpenCodeBin(): string {
  if (process.env.AGENTPRISM_OPENCODE_ACP_CMD) return process.env.AGENTPRISM_OPENCODE_ACP_CMD;
  try {
    return requireAcp.resolve("opencode-ai/bin/opencode");
  } catch {
    // Not a dependency of this repo; try the package root for projects that install it.
  }
  try {
    const packageJson = requireAcp.resolve("opencode-ai/package.json");
    return join(dirname(packageJson), "bin", "opencode");
  } catch {
    return "opencode";
  }
}

// The stable, prefix-independent argv marker: the package-scoped tail of the resolved bin
// (e.g. "@automatalabs/codex-acp/dist/index.js"). Derived from the real resolved path — not a
// hand-written guess — and present ONLY on the npm path (a vendored copy would be
// ".../vendor/codex-acp/..." with no npm scope).
function pkgTail(full: string): string {
  for (const scope of ["@automatalabs/", "@agentclientprotocol/"]) {
    const i = full.indexOf(scope);
    if (i >= 0) return full.slice(i);
  }
  return full;
}

// The schema'd agents must each return THIS object (validated by both the backend's native
// structured-output channel and, here, an independent typebox Check on the way out).
const SMALL = {
  type: "object",
  additionalProperties: false,
  required: ["repo", "fileCount"],
  properties: { repo: { type: "string" }, fileCount: { type: "number" } },
} as const;

const AGENT_PROMPT =
  'Return a JSON object describing a code repository with exactly these values: repo="agentprism" and fileCount=42. ' +
  "Output ONLY the JSON object. Do not call any tools.";

const OPENCODE_AGENT_PROMPT =
  'Return a JSON object describing a code repository with exactly these values: repo="agentprism" and fileCount=42.';

/** A meta + 3-schema'd-agent parallel() workflow script (concurrency 3 => 3 live sessions on
 *  ONE pooled process). For injected-tool backends (OpenCode) the runner SERIALIZES the three
 *  schema runs internally — instance-global name-keyed MCP registries expose every registered
 *  tool to every live session, so overlapping injected sessions would leak captures across
 *  sessions. parallel() here deliberately exercises that serialization end to end. */
function buildScript(backend: Backend, modelSpec?: string): string {
  const prompt = backend === "opencode" ? OPENCODE_AGENT_PROMPT : AGENT_PROMPT;
  const modelEntry = modelSpec ? `, model: ${JSON.stringify(modelSpec)}` : "";
  return [
    `export const meta = { name: 'live-${backend}', description: 'pooling reuse + structured output', phases: [{ title: 'Fan' }] };`,
    `const SMALL = ${JSON.stringify(SMALL)};`,
    `phase('Fan');`,
    `const results = await parallel([`,
    `  () => agent(${JSON.stringify(prompt)}, { label: 'a1', phase: 'Fan', schema: SMALL${modelEntry} }),`,
    `  () => agent(${JSON.stringify(prompt)}, { label: 'a2', phase: 'Fan', schema: SMALL${modelEntry} }),`,
    `  () => agent(${JSON.stringify(prompt)}, { label: 'a3', phase: 'Fan', schema: SMALL${modelEntry} }),`,
    `]);`,
    `return results;`,
  ].join("\n");
}

interface PerResult {
  isObject: boolean;
  typeboxCheck: boolean;
  value: unknown;
}

interface LiveOutcome {
  ran: boolean;
  status: unknown;
  isError: boolean;
  resultCount: number;
  allValidated: boolean;
  perResult: PerResult[];
  progressEvents: number;
  serverPid: number | null;
  backendPids: number[];
  backendProcCount: number;
  pollSamples: number;
  samplesWithBackend: number;
  maxSamplesForOnePid: number;
  trailingSawBackend: boolean;
  errors: string[];
  serverStderrTail: string;
}

type Json = Record<string, unknown>;
const asObject = (v: unknown): Json | undefined =>
  v !== null && typeof v === "object" ? (v as Json) : undefined;

/**
 * Drive ONE backend end to end: spawn the real mcp-server over stdio, list tools (so the
 * client-side outputSchema validator compiles), call `workflow` with the 3-agent parallel()
 * at concurrency 3, and meanwhile poll `ps` for the server's DIRECT child ACP subprocess(es)
 * carrying the backend marker. Returns the gathered evidence; the per-backend test asserts.
 */
async function runLiveBackend(backend: Backend): Promise<LiveOutcome> {
  const tbValue = (await import(pathToFileURL(requireAcp.resolve("typebox/value")).href)) as {
    Check: (schema: unknown, value: unknown) => boolean;
    Convert: (schema: unknown, value: unknown) => unknown;
  };
  const { Check, Convert } = tbValue;

  const MARKER = pkgTail(BACKEND_BIN[backend]);
  const script = buildScript(backend, backend === "opencode" ? OPENCODE_E2E_MODEL : undefined);

  const out: LiveOutcome = {
    ran: false,
    status: null,
    isError: false,
    resultCount: 0,
    allValidated: false,
    perResult: [],
    progressEvents: 0,
    serverPid: null,
    backendPids: [],
    backendProcCount: 0,
    pollSamples: 0,
    samplesWithBackend: 0,
    maxSamplesForOnePid: 0,
    trailingSawBackend: false,
    errors: [],
    serverStderrTail: "",
  };

  // Pass the REAL environment (the backends read their normal auth files from $HOME), pin the
  // default backend, and DELETE the pool-size knob so
  // the default (size 1) is what proves "exactly one process".
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTPRISM_DEFAULT_BACKEND: backend };
  delete env.AGENTPRISM_ACP_POOL_SIZE;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: env as Record<string, string>,
    stderr: "pipe",
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
  });
  const client = new Client({ name: "live-e2e-harness", version: "0.0.0" }, { capabilities: {} });

  let stderrBuf = "";
  transport.stderr?.on("data", (c: Buffer) => {
    stderrBuf = (stderrBuf + c.toString()).slice(-8000);
  });

  // pid -> count of poll samples in which we saw it (a DIRECT child of the server carrying
  // the backend marker). Distinct keys = distinct backend processes over the whole run.
  const pidSamples = new Map<number, number>();
  function pollOnce(): void {
    if (out.serverPid === null) return;
    out.pollSamples++;
    let psOut = "";
    try {
      psOut = execSync("ps -eo pid=,ppid=,args=", { encoding: "utf8" });
    } catch {
      return;
    }
    let sawAny = false;
    for (const line of psOut.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const args = m[3];
      if (ppid !== out.serverPid) continue; // only DIRECT children of the pooled mcp-server
      if (!args.includes(MARKER)) continue;
      sawAny = true;
      pidSamples.set(pid, (pidSamples.get(pid) ?? 0) + 1);
    }
    if (sawAny) out.samplesWithBackend++;
    return;
  }

  const timeoutMs = 240_000;
  let timer: NodeJS.Timeout | undefined;
  let poller: NodeJS.Timeout | undefined;
  try {
    await client.connect(transport);
    out.serverPid = transport.pid ?? null;

    poller = setInterval(pollOnce, 150);

    const callPromise = client.callTool({ name: "workflow", arguments: { script, concurrency: 3 } }, undefined, {
      onprogress: () => {
        out.progressEvents++;
      },
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`callTool timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    let res: Awaited<ReturnType<Client["callTool"]>>;
    try {
      res = (await Promise.race([callPromise, timeoutPromise])) as Awaited<ReturnType<Client["callTool"]>>;
    } finally {
      if (poller) clearInterval(poller);
      // Trailing sample: the pooled process must STILL be a live child right after the calls
      // (pooling keeps it; a per-session spawn/kill model would have torn it down).
      pollOnce();
      out.trailingSawBackend = pidSamples.size > 0 && out.samplesWithBackend > 0;
    }

    out.ran = true;
    const sc = asObject(res.structuredContent) ?? {};
    out.status = sc.status ?? null;
    out.isError = res.isError === true;
    const arr = Array.isArray(sc.result) ? sc.result : [];
    out.resultCount = arr.length;
    let allOk = arr.length === 3;
    for (const r of arr) {
      const isObject = r !== null && typeof r === "object" && !Array.isArray(r);
      let checked = false;
      try {
        checked = Check(SMALL, r) || Check(SMALL, Convert(SMALL, r));
      } catch {
        checked = false;
      }
      out.perResult.push({ isObject, typeboxCheck: checked, value: r });
      if (!isObject || !checked) allOk = false;
    }
    out.allValidated = allOk;
  } catch (err) {
    out.errors.push(String((err as { stack?: string; message?: string })?.stack ?? err));
  } finally {
    if (timer) clearTimeout(timer);
    if (poller) clearInterval(poller);
    out.backendPids = [...pidSamples.keys()];
    out.backendProcCount = out.backendPids.length;
    out.maxSamplesForOnePid = Math.max(0, ...pidSamples.values());
    out.serverStderrTail = stderrBuf.slice(-3000);
    try {
      await client.close();
    } catch {
      /* best-effort */
    }
    try {
      await transport.close();
    } catch {
      /* best-effort */
    }
  }
  return out;
}

/** Compact diagnostic block surfaced on any assertion failure (incl. auth failures). */
function diag(backend: Backend, out: LiveOutcome): string {
  return [
    `\n--- live ${backend} e2e diagnostics ---`,
    `ran=${out.ran} status=${JSON.stringify(out.status)} isError=${out.isError}`,
    `resultCount=${out.resultCount} allValidated=${out.allValidated} progressEvents=${out.progressEvents}`,
    `serverPid=${out.serverPid} backendPids=${JSON.stringify(out.backendPids)} backendProcCount=${out.backendProcCount}`,
    `pollSamples=${out.pollSamples} samplesWithBackend=${out.samplesWithBackend} maxSamplesForOnePid=${out.maxSamplesForOnePid}`,
    `perResult=${JSON.stringify(out.perResult)}`,
    out.errors.length ? `errors=${out.errors.join(" | ")}` : "errors=none",
    `serverStderrTail<<<\n${out.serverStderrTail}\n>>>`,
  ].join("\n");
}

/** Assert the gathered evidence proves BOTH cruxes for one backend. */
function assertBackend(backend: Backend, out: LiveOutcome): void {
  const d = () => diag(backend, out);
  const bin = BACKEND_BIN[backend];

  // De-vendor proof for bundled adapters: Claude/Codex spawn targets are npm installs under
  // their published scopes. OpenCode is explicitly not bundled; it may be PATH, env override,
  // or a host-installed opencode-ai package.
  if (backend !== "opencode") {
    const scope = BACKEND_SCOPE[backend];
    assert.ok(bin.includes("/node_modules/"), `${backend} bin must resolve under node_modules: ${bin}`);
    assert.ok(bin.includes(scope), `${backend} bin must be the ${scope} npm package: ${bin}`);
    assert.ok(!bin.includes("/vendor/"), `${backend} must NOT use a vendored copy: ${bin}`);
  } else {
    assert.ok(bin.length > 0, "opencode spawn marker must be non-empty");
  }

  // The run must reach the handler with no harness/timeout error and no tool-level error.
  assert.equal(out.errors.length, 0, `live ${backend} run threw before assertion${d()}`);
  assert.equal(out.ran, true, `live ${backend} run did not complete the callTool${d()}`);
  assert.equal(
    out.isError,
    false,
    `live ${backend} returned a tool error (likely auth/network) — when gated ON this FAILS, it does not silently pass${d()}`,
  );
  assert.equal(out.status, "completed", `live ${backend} did not reach terminal 'completed'${d()}`);

  // Crux 1: THREE typebox-validated structured OBJECTS (not text).
  assert.equal(out.resultCount, 3, `live ${backend} must return exactly 3 agent results${d()}`);
  for (const [i, r] of out.perResult.entries()) {
    assert.ok(r.isObject, `live ${backend} result[${i}] is a structured object (not text)${d()}`);
    assert.ok(r.typeboxCheck, `live ${backend} result[${i}] validates against the typebox schema${d()}`);
  }
  assert.equal(out.allValidated, true, `live ${backend} all 3 results schema-validate${d()}`);

  // Progress fired.
  assert.ok(out.progressEvents > 0, `live ${backend} emitted at least one progress event${d()}`);

  // Crux 2: pooling reuse — EXACTLY ONE long-lived backend subprocess (a DIRECT child of the
  // server) served all three sessions. >1 distinct child PID would mean a per-session spawn.
  assert.ok(out.samplesWithBackend > 0, `live ${backend} never observed the backend subprocess via ps${d()}`);
  assert.equal(
    out.backendProcCount,
    1,
    `live ${backend} pooling reuse: exactly ONE backend subprocess must serve all 3 sessions${d()}`,
  );
  // The single process is long-lived (seen across multiple polls + still alive after the run).
  assert.ok(out.maxSamplesForOnePid >= 2, `live ${backend} the one backend process must be long-lived${d()}`);
  assert.ok(out.trailingSawBackend, `live ${backend} the pooled process must still be alive after the run${d()}`);
}

test("live-backend e2e: claude drives schema'd structured output with single-process pooling reuse", {
  skip: SKIP,
  timeout: 300_000,
}, async () => {
  assert.ok(existsSync(SERVER_ENTRY), `built server entry missing — run \`pnpm build\` first: ${SERVER_ENTRY}`);
  const out = await runLiveBackend("claude");
  assertBackend("claude", out);
});

test("live-backend e2e: codex (npm-installed + pnpm-patched) drives schema'd structured output with single-process pooling reuse", {
  skip: SKIP,
  timeout: 300_000,
}, async () => {
  assert.ok(existsSync(SERVER_ENTRY), `built server entry missing — run \`pnpm build\` first: ${SERVER_ENTRY}`);
  const out = await runLiveBackend("codex");
  assertBackend("codex", out);
});

test("live-backend e2e: opencode drives schema'd structured output through the injected StructuredOutput tool", {
  skip: SKIP,
  timeout: 300_000,
}, async () => {
  assert.ok(existsSync(SERVER_ENTRY), `built server entry missing — run \`pnpm build\` first: ${SERVER_ENTRY}`);
  const out = await runLiveBackend("opencode");
  assertBackend("opencode", out);
});
