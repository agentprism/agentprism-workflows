// quick-wins — a small, self-contained hunter that repo-triage nests by name
// (`workflow("quick-wins", {...})`) and that also runs standalone:
//
//   npm start -- --workflow quick-wins
//   npx agentprism-workflows validate quick-wins --workflows-dir workflows
//
// Demonstrates loopUntilDry(): keep spawning hunt rounds — each on the next vendor
// in the pool — until two consecutive rounds add nothing new (or the round cap /
// token budget stops it first). Workflow scripts are self-contained strings with no
// imports, so the vendor pool is repeated here rather than shared with repo-triage.
export const meta = {
  name: "quick-wins",
  description: "Hunt small, high-confidence quick wins across the repo until two consecutive rounds come up dry",
  phases: [{ title: "Hunt" }],
};

// args — every knob optional; hosts may hand args through as a JSON string.
const raw = typeof args === "string" ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : args;
const opt = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
const rounds = Number.isFinite(Number(opt.rounds)) && Number(opt.rounds) >= 1 ? Math.floor(Number(opt.rounds)) : 4;
const focus =
  typeof opt.focus === "string" && opt.focus.trim().length > 0
    ? opt.focus.trim()
    : "small, safe, high-confidence improvements";
const avoid = Array.isArray(opt.avoid) ? opt.avoid.filter((x) => typeof x === "string") : [];

// These registered-prefix specs use ids verified against each live harness catalog.
const POOL = [
  { name: "claude", model: "claude/opus[1m]", mode: "plan" },
  { name: "codex", model: "codex/gpt-5.6-sol", mode: "read-only" },
  { name: "opencode", model: "opencode/zai/glm-5.2" },
];

const WINS = {
  type: "object",
  additionalProperties: false,
  required: ["wins"],
  properties: {
    wins: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "summary", "action"],
        properties: {
          file: {
            type: "string",
            description: "Repo-relative path of a file you actually opened — copy it exactly, never invent one",
          },
          summary: { type: "string", description: "One sentence: the small problem or missed improvement" },
          action: { type: "string", description: "The concrete, low-risk change that fixes it, in one clause" },
        },
      },
    },
  },
};

phase("Hunt");
const seen = [];
const wins = await loopUntilDry({
  round: async (i) => {
    // Budget floor: leave headroom for whatever runs after this hunt. When nested
    // inside repo-triage, budget.* reads the PARENT run's shared budget.
    if (budget.total && budget.remaining() < 30_000) {
      log(`Hunt round ${i + 1}: stopping — only ${budget.remaining()} tokens left`);
      return [];
    }
    const v = POOL[i % POOL.length];
    const r = await agent(
      `Hunt round ${i + 1}: find up to 3 quick wins in this repository — ${focus}. ` +
        "A quick win is a small, safe, self-contained improvement (a missing guard, a stale doc line, an obvious dead branch), " +
        "not a refactor. Open files and ground every entry in code you actually read; never emit a placeholder.\n" +
        `Already known — do NOT repeat anything on this list: ${JSON.stringify([...avoid, ...seen])}`,
      { label: `hunt:${i + 1}:${v.name}`, phase: "Hunt", schema: WINS, model: v.model, mode: v.mode },
    );
    const found = (r?.wins ?? []).filter((w) => typeof w.file === "string" && w.file.length > 0 && !w.file.startsWith("/"));
    seen.push(...found.map((w) => `${w.file}: ${w.summary}`));
    return found.map((w) => ({ ...w, foundBy: v.name }));
  },
  key: (w) => `${w.file}::${w.summary}`,
  consecutiveEmpty: 2,
  maxRounds: rounds,
});

log(`quick-wins: ${wins.length} unique wins across the hunt`);
return { wins };
