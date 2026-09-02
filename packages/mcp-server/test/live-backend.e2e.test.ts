// Live-backend end-to-end regression test (env-GATED, skip-by-default).
//
// Every OTHER suite in this repo speaks ACP to a FAKE (stub AgentRunner / in-memory
// transport). This one drives the REAL built mcp-server over stdio and the REAL backend
// ACP servers (claude-agent-acp, the npm deps codex-acp and pi-acp, and OpenCode), so
// the two structured-output cruxes — (1) a schema'd agent yields a typebox-validated
// structured OBJECT (not text), and (2) ONE long-lived pooled backend subprocess serves
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";

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
import type { BuiltinBackendId } from "@automatalabs/acp-agents";

type Backend = BuiltinBackendId;

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
// in the spawned subprocess's argv — and provably an npm install, not a vendored copy. Pi is
// a workspace:* sibling, so in-repo it resolves to packages/pi-acp/dist (the exact artifact
// npm publishes) instead of node_modules.
const requireAcp = createRequire(new URL("../../acp-agents/package.json", import.meta.url));
const WORKSPACE_DIST: Partial<Record<Backend, string>> = {
  pi: fileURLToPath(new URL("../../pi-acp/dist/", import.meta.url)),
  codex: fileURLToPath(new URL("../../codex-acp/dist/", import.meta.url)),
};
const BACKEND_BIN: Record<Backend, string> = {
  claude: requireAcp.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"),
  codex: requireAcp.resolve("@automatalabs/codex-acp"),
  opencode: resolveOpenCodeBin(),
  pi: join(dirname(requireAcp.resolve("@automatalabs/pi-acp")), "index.js"),
};

// Each backend's ACP server is a published npm package under its own scope: Claude stays on the
// upstream @agentclientprotocol adapter; Codex is our patched @automatalabs fork.
const BACKEND_SCOPE: Record<Exclude<Backend, "opencode">, string> = {
  claude: "@agentclientprotocol/",
  codex: "@automatalabs/",
  pi: "@automatalabs/",
};

// Kimi K3 rate-buckets concurrent bursts: with process-exclusive injected pooling (#292) the
// three schema runs fire simultaneously and Kimi reliably drops one of the three. DeepSeek v4
// Flash tolerates the 3-wide burst on the same OpenCode/OpenRouter routing.
const OPENCODE_E2E_MODEL = process.env.AGENTPRISM_OPENCODE_E2E_MODEL ?? "opencode/openrouter/deepseek/deepseek-v4-flash";
// Kimi K3 can exceed the MCP request deadline under provider load. Gemini Flash exercises the
// same Pi/OpenRouter routing and native schema path with enough latency headroom for all four calls.
const PI_E2E_MODEL = process.env.AGENTPRISM_PI_E2E_MODEL ?? "openrouter/google/gemini-2.5-flash";
// The Claude adapter validates `model` against the SESSION's selectable option list — the CLI's
// model picker for that working directory — not the Anthropic model catalog. A model can be
// perfectly valid and still be rejected here as "Invalid value for config option model" simply
// because it isn't in that session's picker. ANTHROPIC_DEFAULT_OPUS_MODEL (exported by
// .githooks/pre-push) is what puts it there; naming the model explicitly then makes the leg fail
// loudly if it ever stops being selectable, instead of silently running the CLI's default.
const CLAUDE_E2E_MODEL = process.env.AGENTPRISM_CLAUDE_E2E_MODEL ?? "claude/claude-opus-4-8";

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
const SMOKE_PROMPT = "Reply with exactly LIVE_SMOKE_OK and no other text. Do not call tools.";

/** A meta + 3-schema'd-agent parallel() workflow plus one schema-less smoke call (concurrency 3
 *  => 3 simultaneous live sessions, followed by one ordinary text session). Native-channel
 *  backends (Claude/Codex) multiplex all four sessions on ONE pooled process. Injected-tool
 *  backends (OpenCode/Pi) instead reserve one process per concurrent injected run — process
 *  isolation replaces the old per-connection serialization (#292) — so the three schema runs
 *  overlap on THREE elastic processes and the schema-less smoke reuses the steady-state one.
 *  parallel() here deliberately exercises that process-exclusive overlap end to end. */
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
    `const smoke = await agent(${JSON.stringify(SMOKE_PROMPT)}, { label: 'smoke', phase: 'Fan'${modelEntry} });`,
    `return { structured: results, smoke };`,
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
  smokeValue: unknown;
  smokePass: boolean;
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
  const model =
    backend === "opencode"
      ? OPENCODE_E2E_MODEL
      : backend === "pi"
        ? PI_E2E_MODEL
        : backend === "claude"
          ? CLAUDE_E2E_MODEL
          : undefined;
  const script = buildScript(backend, model);

  const out: LiveOutcome = {
    ran: false,
    status: null,
    isError: false,
    resultCount: 0,
    allValidated: false,
    perResult: [],
    smokeValue: null,
    smokePass: false,
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

    const callPromise = client.callTool({ name: "workflow", arguments: { script, concurrency: 3 } }, {
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
    const result = asObject(sc.result) ?? {};
    const arr = Array.isArray(result.structured) ? result.structured : [];
    out.smokeValue = result.smoke;
    // The model must reply with exactly LIVE_SMOKE_OK, but agent CLIs may
    // prepend their own banners to the message text (Codex injects a skills
    // context-budget warning when local skills are installed) — judge the
    // last non-empty line, not the whole string.
    const smokeLines = typeof result.smoke === "string" ? result.smoke.trim().split("\n") : [];
    out.smokePass = smokeLines.at(-1)?.trim() === "LIVE_SMOKE_OK";
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
    `smokePass=${out.smokePass} smokeValue=${JSON.stringify(out.smokeValue)}`,
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

  // De-vendor proof for bundled adapters: Claude/Codex/Pi spawn targets are npm installs under
  // their published scopes. OpenCode is explicitly not bundled; it may be PATH, env override,
  // or a host-installed opencode-ai package.
  if (backend !== "opencode") {
    const scope = BACKEND_SCOPE[backend];
    const workspaceDist = WORKSPACE_DIST[backend];
    if (workspaceDist !== undefined && !bin.includes("/node_modules/")) {
      // workspace:* topology — acp-agents links the repo's own package (pi-acp, codex-acp), the
      // exact artifact npm publishes; consumer installs resolve it under node_modules instead.
      assert.ok(bin.startsWith(workspaceDist), `${backend} bin must be the workspace ${scope} dist: ${bin}`);
    } else {
      assert.ok(bin.includes("/node_modules/"), `${backend} bin must resolve under node_modules: ${bin}`);
      assert.ok(bin.includes(scope), `${backend} bin must be the ${scope} npm package: ${bin}`);
    }
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

  // Schema-less seam: the same registry-routed backend also returns ordinary assistant text.
  assert.equal(out.smokePass, true, `live ${backend} schema-less smoke must return LIVE_SMOKE_OK${d()}`);

  // Progress fired.
  assert.ok(out.progressEvents > 0, `live ${backend} emitted at least one progress event${d()}`);

  // Crux 2: pooling shape. Native-channel backends (Claude/Codex) multiplex all four sessions
  // on EXACTLY ONE long-lived subprocess; >1 distinct child PID would mean a per-session spawn.
  // Injected-tool backends (OpenCode/Pi) reserve one process per concurrent injected run (#292):
  // the 3-wide parallel() must show EXACTLY THREE distinct subprocesses (the schema-less smoke
  // reuses a steady-state one); 1 would mean the old serialization, 4 a per-session spawn.
  assert.ok(out.samplesWithBackend > 0, `live ${backend} never observed the backend subprocess via ps${d()}`);
  const injected = backend === "opencode" || backend === "pi";
  assert.equal(
    out.backendProcCount,
    injected ? 3 : 1,
    injected
      ? `live ${backend} process-exclusive overlap: the 3 injected runs must land on 3 distinct subprocesses${d()}`
      : `live ${backend} pooling reuse: exactly ONE backend subprocess must serve all 4 sessions${d()}`,
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

test("live-backend e2e: codex npm package drives schema'd structured output with single-process pooling reuse", {
  skip: SKIP,
  timeout: 300_000,
}, async () => {
  assert.ok(existsSync(SERVER_ENTRY), `built server entry missing — run \`pnpm build\` first: ${SERVER_ENTRY}`);
  const out = await runLiveBackend("codex");
  assertBackend("codex", out);
});

test("live-backend e2e: opencode drives injected StructuredOutput with process-exclusive overlap", {
  skip: SKIP,
  timeout: 300_000,
}, async () => {
  assert.ok(existsSync(SERVER_ENTRY), `built server entry missing — run \`pnpm build\` first: ${SERVER_ENTRY}`);
  const out = await runLiveBackend("opencode");
  assertBackend("opencode", out);
});

test("live-backend e2e: pi drives injected StructuredOutput with process-exclusive overlap", {
  skip: SKIP,
  timeout: 300_000,
}, async () => {
  assert.ok(existsSync(SERVER_ENTRY), `built server entry missing — run \`pnpm build\` first: ${SERVER_ENTRY}`);
  const out = await runLiveBackend("pi");
  assertBackend("pi", out);
});

test("live workflow config discovery: every backend exposes its no-prompt catalog without a run", {
  skip: SKIP,
  timeout: 300_000,
}, async () => {
  assert.ok(existsSync(SERVER_ENTRY), `built server entry missing — run \`pnpm build\` first: ${SERVER_ENTRY}`);
  const projectDir = fileURLToPath(new URL("../../..", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env } as Record<string, string>,
    stderr: "pipe",
    cwd: projectDir,
  });
  const client = new Client({ name: "live-config-discovery", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "workflow",
      arguments: {
        action: "config",
        projectDir,
        harnesses: ["claude", "codex", "opencode", "pi"],
      },
    }, { timeout: 240_000, maxTotalTimeout: 240_000 });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const output = result.structuredContent as Record<string, unknown>;
    assert.equal(output.action, "config");
    assert.equal(output.ok, true, JSON.stringify(output));
    assert.equal(output.runId, undefined, "config discovery creates no workflow run");
    const rows = output.harnessOptions as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => row.backendId), ["claude", "codex", "opencode", "pi"]);
    assert.ok(rows.every((row) => row.probed === true), JSON.stringify(rows));
    assert.ok(rows.every((row) => Object.hasOwn(row, "modes")), `every successful row explicitly reports modes: ${JSON.stringify(rows)}`);
    assert.equal(rows.find((row) => row.backendId === "pi")?.modes, null, "Pi explicitly advertises no ACP session modes");

    const guessedMode = await client.callTool({
      name: "workflow",
      arguments: {
        projectDir,
        script: [
          'export const meta = { name: "live-pi-mode-rejection", description: "reject guessed mode before admission" };',
          `return agent("x", { label: "pi-mode", model: ${JSON.stringify(`pi/${PI_E2E_MODEL}`)}, mode: "default" });`,
        ].join("\n"),
      },
    }, { timeout: 240_000, maxTotalTimeout: 240_000 });
    assert.equal(guessedMode.isError, true, JSON.stringify(guessedMode));
    const rejected = guessedMode.structuredContent as Record<string, unknown>;
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.runId, undefined);
    assert.match(JSON.stringify(rejected), /mode authored value \\"default\\" is not advertised/);
    assert.match(JSON.stringify(rejected), /advertised modes: \(none advertised\)/);

    const exactPi = await client.callTool({
      name: "workflow",
      arguments: {
        action: "config",
        projectDir,
        modelSpecs: [`pi/${PI_E2E_MODEL}`],
      },
    }, { timeout: 240_000, maxTotalTimeout: 240_000 });
    assert.notEqual(exactPi.isError, true, JSON.stringify(exactPi));
    const exactPiRow = ((exactPi.structuredContent as Record<string, unknown>).harnessOptions as Array<Record<string, unknown>>)[0];
    const thinking = (exactPiRow.options as Array<Record<string, unknown>>).find((option) => option.id === "thinkingLevel");
    assert.equal(typeof thinking?.currentValue, "string", JSON.stringify(exactPiRow));

    const replFailure = await client.callTool({
      name: "repl",
      arguments: {
        action: "eval",
        projectDir,
        timeoutMs: 120_000,
        code: `await agent(${JSON.stringify(`pi/${PI_E2E_MODEL}`)}, "must never prompt", { mode: "default", configOptions: { thinkingLevel: ${JSON.stringify(thinking?.currentValue)} } }).catch(e => e.name + ": " + e.message)`,
      },
    }, { timeout: 240_000, maxTotalTimeout: 240_000 });
    assert.notEqual(replFailure.isError, true, JSON.stringify(replFailure));
    const replResult = (replFailure.structuredContent as Record<string, unknown>).result;
    assert.equal(typeof replResult, "string", JSON.stringify(replFailure.structuredContent));
    assert.match(replResult as string, /cannot apply session mode "default" \(advertised modes: none\)/);
    assert.doesNotMatch(replResult as string, /ConfigOptionsError|offending key|thinkingLevel/);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});

test("live REPL queue smoke: Claude, Codex, OpenCode, and Pi continue one session through broker-owned FIFO prompts", {
  skip: SKIP,
  timeout: 600_000,
}, async () => {
  assert.ok(existsSync(SERVER_ENTRY), `built server entry missing — run \`pnpm build\` first: ${SERVER_ENTRY}`);
  const projectDir = fileURLToPath(new URL("../../..", import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: env as Record<string, string>,
    stderr: "pipe",
    cwd: projectDir,
  });
  const client = new Client({ name: "live-repl-queue", version: "0.0.0" }, { capabilities: {} });
  const specs = {
    claude: CLAUDE_E2E_MODEL,
    codex: "codex",
    opencode: OPENCODE_E2E_MODEL,
    pi: `pi/${PI_E2E_MODEL}`,
  } as const;
  const names = Object.keys(specs) as Array<keyof typeof specs>;
  const suffix = `${Date.now().toString(36)}_${process.pid}`;
  const handleName = (name: keyof typeof specs): string => `live_${name}_${suffix}`;
  const queueName = (name: keyof typeof specs): string => `queued_${name}_${suffix}`;
  const lastLine = (value: unknown): string =>
    typeof value === "string" ? (value.trim().split("\n").at(-1)?.trim() ?? "") : "";
  try {
    await client.connect(transport);
    const foundingSource = names.map((name) =>
      `const ${handleName(name)} = agent(${JSON.stringify(specs[name])}, ${JSON.stringify(`Reply with exactly FOUNDING_${name.toUpperCase()} and no other text. Do not call tools.`)});`,
    ).join("\n") +
      `\nJSON.stringify(await Promise.all([${names.map(handleName).join(", ")}]))`;
    const founding = await client.callTool({
      name: "repl",
      arguments: { action: "eval", projectDir, code: foundingSource, timeoutMs: 120_000 },
    }, { timeout: 240_000, maxTotalTimeout: 240_000 });
    assert.notEqual(founding.isError, true, JSON.stringify(founding));
    const foundingResult = (founding.structuredContent as Record<string, unknown> | undefined)?.result;
    assert.equal(typeof foundingResult, "string", JSON.stringify(founding.structuredContent));
    const foundingValues = JSON.parse(foundingResult as string) as unknown[];
    assert.deepEqual(
      foundingValues.map(lastLine),
      names.map((name) => `FOUNDING_${name.toUpperCase()}`),
    );

    const queueSource = names.map((name) =>
      `const ${queueName(name)} = ${handleName(name)}.queue(${JSON.stringify(`Reply with exactly QUEUE_${name.toUpperCase()} and no other text. Do not call tools.`)});`,
    ).join("\n") +
      `\nJSON.stringify(await Promise.all([${names.map(queueName).join(", ")}]))`;
    const queued = await client.callTool({
      name: "repl",
      arguments: { action: "eval", projectDir, code: queueSource, timeoutMs: 120_000 },
    }, { timeout: 240_000, maxTotalTimeout: 240_000 });
    assert.notEqual(queued.isError, true, JSON.stringify(queued));
    const queuedResult = (queued.structuredContent as Record<string, unknown> | undefined)?.result;
    assert.equal(typeof queuedResult, "string", JSON.stringify(queued.structuredContent));
    const queuedValues = JSON.parse(queuedResult as string) as unknown[];
    assert.deepEqual(
      queuedValues.map(lastLine),
      names.map((name) => `QUEUE_${name.toUpperCase()}`),
    );
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});
