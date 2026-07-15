#!/usr/bin/env node
// Host runner for the image-gate example.
//
//   NANOBANANA_MCP=/abs/path/to/nanobanana/mcp-server/dist/index.js \
//   GEMINI_API_KEY=... \
//   node run.mjs --brand AgentPrism "an attractive README.md banner image"
//
// --brand <name>  exact product name to render in the image (default: AgentPrism)
// remaining args  the request (what kind of image you want)
//
// Imports the workspace build directly; a standalone project would instead
// `pnpm add @automatalabs/workflows` and import from the package name.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpRunner, runDynamicWorkflow } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

const argv = process.argv.slice(2);
let brand = "AgentPrism";
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--brand") brand = argv[++i] ?? brand;
  else rest.push(argv[i]);
}
const request = rest.join(" ").trim() || "An attractive README.md banner image for this repository";

const serverEntry = process.env.NANOBANANA_MCP;
if (!serverEntry) {
  console.error("Set NANOBANANA_MCP to the absolute path of nanobanana/mcp-server/dist/index.js");
  console.error("(clone https://github.com/gemini-cli-extensions/nanobanana and `npm install` in mcp-server/ — prepare builds dist/)");
  process.exit(1);
}
const apiKey = process.env.GEMINI_API_KEY ?? process.env.NANOBANANA_API_KEY ?? process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("Set GEMINI_API_KEY (or NANOBANANA_API_KEY / GOOGLE_API_KEY) for the nanobanana server");
  process.exit(1);
}

const script = readFileSync(resolve(here, "image-gate.workflow.js"), "utf8");

// Own the runner explicitly so we can watch the live ACP stream and dispose the
// pooled backend processes at the end (otherwise the node process lingers).
const runner = createAcpRunner();
let lastProgress = "";

// claude-agent-acp emits title-only tool_call events; the interesting bits (file locations,
// the shell command in rawInput) arrive later on tool_call_update. Print the tool line
// immediately, then a detail line once per toolCallId when the detail first shows up.
const detailOf = (e) => {
  if (e.locations?.length) return e.locations.map((l) => l.path).join(", ");
  const input = e.rawInput ?? {};
  if (input.command) return `$ ${String(input.command).slice(0, 100)}`;
  if (input.file_path || input.path) return String(input.file_path ?? input.path);
  if (input.prompt) return `"${String(input.prompt).slice(0, 80)}…"`;
  return "";
};
const toolCalls = new Map(); // toolCallId → { label, title, detailShown }
runner.on("tool_call", (e) => {
  const label = e.label ?? e.sessionId;
  const detail = detailOf(e);
  toolCalls.set(e.toolCallId, { label, title: e.title, detailShown: Boolean(detail) });
  console.error(`  [${label}] tool: ${e.title}${detail ? ` → ${detail}` : ""}`);
});
runner.on("tool_call_update", (e) => {
  const call = toolCalls.get(e.toolCallId);
  if (!call || call.detailShown) return;
  const detail = detailOf(e);
  if (!detail) return;
  call.detailShown = true;
  console.error(`  [${call.label}] tool: ${e.title ?? call.title} → ${detail}`);
});

try {
  const run = await runDynamicWorkflow(script, {
    runner,
    // Every agent session runs at the repo root, so the brief agent's relative ls/grep
    // explore the right tree. (nanobanana then writes to <repoRoot>/nanobanana-output/.)
    cwd: repoRoot,
    args: {
      brand,
      request,
      repoRoot,
      attempts: 3,
      // Art direction and review are judgment-heavy — pin them to Fable 5. The producer
      // stays on the session default; its job is tool-calling, not taste.
      models: { brief: "claude/claude-fable-5[1m]", validate: "claude/claude-fable-5[1m]" },
      nanobanana: {
        command: process.execPath, // node
        args: [resolve(serverEntry)],
        env: [{ name: "GEMINI_API_KEY", value: apiKey }],
      },
    },
    exec: {
      onProgress: (s) => {
        const running = s.agents.filter((a) => a.status === "running").map((a) => a.label).join(", ");
        const line = `progress: ${s.doneCount}/${s.agentCount} agents done${running ? ` — running: ${running}` : ""}`;
        if (line !== lastProgress) console.error((lastProgress = line));
      },
    },
  });

  console.log(`\nstatus:  ${run.status}${run.reason ? ` (${run.reason})` : ""}`);
  console.log(`result:  ${JSON.stringify(run.result, null, 2)}`);
  if (run.tokenUsage) console.log(`tokens:  ${run.tokenUsage.total}`);
  if (run.logs.length) console.log(`logs:\n  ${run.logs.join("\n  ")}`);
  process.exitCode = run.status === "completed" && run.result?.accepted ? 0 : 1;
} finally {
  await runner.dispose();
}
