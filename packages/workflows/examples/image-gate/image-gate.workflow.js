// image-gate.workflow.js — brief → generate → validate, with a feedback retry loop.
//
//   1. Brief:    an agent explores the repo and writes an art-direction brief (a rich,
//                self-contained image prompt + the exact text the banner must carry).
//   2. Generate: an agent wired to the nanobanana MCP server renders the brief.
//   3. Validate: an agent VIEWS the image and judges it against the brief — including
//                exact spelling of the required text. A rejection loops back to the
//                producer with feedback (bounded by `attempts`).
//
// This file is read as TEXT by run.mjs and executed in the engine's vm realm: `agent`,
// `gate`, `log`, `args` are realm globals (see the SDK's dsl.d.ts), and the top-level
// `return` is valid there even though an ESM linter would flag it.

export const meta = {
  name: "image-gate",
  description: "repo-aware image brief, nanobanana generation, and a prompt-fidelity gate with feedback retries",
  phases: [{ title: "Brief" }, { title: "Generate" }, { title: "Validate" }],
};

// args (host-provided): {
//   brand:      string — the product name; the ONLY prominent text allowed in the image
//   request:    string — what the user wants (e.g. "an attractive README banner")
//   repoRoot:   string — absolute path of the repo the brief agent should study
//   nanobanana: { command, args, env } — stdio launch config for the nanobanana MCP server
//   attempts?:  number — max generate→validate rounds (default 3)
//   models?:    { brief?, validate? } — model specs for the art-direction and reviewer
//               agents (omitted => the session default model)
// }

const NANOBANANA = {
  name: "nanobanana",
  command: args.nanobanana.command,
  args: args.nanobanana.args ?? [],
  env: args.nanobanana.env ?? [],
};

const BRIEF = {
  type: "object",
  additionalProperties: false,
  required: ["imagePrompt", "exactText"],
  properties: {
    imagePrompt: {
      type: "string",
      description:
        "A detailed, SELF-CONTAINED prompt for an image-generation model: subject, visual metaphor, style, palette, composition, and the text to render. Must not reference 'the repo' or assume any outside context.",
    },
    exactText: {
      type: "array",
      items: { type: "string" },
      description: "Every string that must appear in the image VERBATIM (brand name, optional short tagline). Keep it minimal — image models garble long text.",
    },
    concept: { type: "string", description: "One line explaining the visual concept chosen" },
  },
};

const PRODUCED = {
  type: "object",
  additionalProperties: false,
  required: ["imagePath"],
  properties: {
    imagePath: {
      type: "string",
      description: "Absolute path of the final image file, exactly as reported in the nanobanana tool result",
    },
    notes: { type: "string", description: "One line on what you generated or changed" },
  },
};

const VERDICT = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean", description: "true only if the image matches the brief AND all required text is spelled exactly right" },
    feedback: {
      type: "string",
      description: "Required when ok is false: what is wrong or missing (including any text artifact), and concretely what to change",
    },
  },
};

// ── Phase 1: repo-aware art direction, run ONCE before the gate loop ──
const brief = await agent(
  [
    "You are an art director writing a brief for an AI image-generation model.",
    `The user wants: ${args.request}`,
    `The product is called "${args.brand}" — this EXACT string must be the only prominent text in the image.`,
    "",
    `First, ACTUALLY EXPLORE the repository at ${args.repoRoot} with your tools before writing anything:`,
    "read README.md in full, the root package.json, and EVERY packages/*/package.json (names and",
    "descriptions), and skim docs/. Do not write the brief from the product name alone — the",
    "concept must be grounded in specifics you found (what the packages do, how they compose).",
    "Then design ONE strong visual concept that reflects what the product really provides (its core",
    "metaphor, architecture, or value) — not a generic tech collage.",
    "",
    "Write the brief as a self-contained image prompt: subject and visual metaphor, art style,",
    "color palette, composition/aspect (wide banner), and exactly what text to render.",
    `Text rules: "${args.brand}" verbatim as the title; at most ONE short tagline (5 words or fewer),`,
    "and nothing else — image models garble long text. List every required string in exactText.",
  ].join("\n"),
  { label: "brief", phase: "Brief", schema: BRIEF, model: args.models?.brief },
);
log(`brief: ${brief.concept ?? brief.imagePrompt.slice(0, 120)}`);
log(`exact text: ${JSON.stringify(brief.exactText)}`);

// gate() spawns a FRESH producer each round — no session memory — so anything the next
// attempt needs (the previous image's path) is carried in these closure variables and
// threaded into the prompt alongside the validator's feedback.
let lastImagePath;
let round = 0;

const outcome = await gate(
  // ── Phase 2: a subagent wired to the nanobanana MCP server renders the brief ──
  (feedback) => {
    round += 1;
    const task = [
      "Generate ONE image from this art-direction brief:",
      "",
      brief.imagePrompt,
      "",
      `The image MUST contain this text verbatim, spelled exactly: ${JSON.stringify(brief.exactText)}.`,
      'Use the nanobanana MCP tools available to you (the tool name contains "generate_image";',
      'on a retry you may instead use "edit_image" with the previous file to refine it).',
      "The tool result text lists the generated file path(s). Return the ABSOLUTE path of the",
      "final image as JSON per the output schema. Do not create any other files.",
      feedback
        ? [
            "",
            `This is attempt ${round}. A reviewer REJECTED the previous image (${lastImagePath ?? "path unknown"}) with this feedback:`,
            feedback,
            "Address every point of that feedback in the new image.",
          ].join("\n")
        : "",
    ].join("\n");
    return agent(task, {
      label: `generate:${round}`,
      phase: "Generate",
      schema: PRODUCED,
      mcpServers: [NANOBANANA],
    }).then((produced) => {
      lastImagePath = produced.imagePath;
      log(`round ${round}: produced ${produced.imagePath}`);
      return produced;
    });
  },

  // ── Phase 3: views the image file and judges it against the brief ──
  (produced) =>
    agent(
      [
        "You are a strict image QA reviewer.",
        `The user asked for: ${args.request}`,
        "The image was generated from this brief:",
        brief.imagePrompt,
        "",
        `The candidate image is at: ${produced.imagePath}`,
        "View the image file with your file-reading tool, then judge:",
        `1. TEXT (hardest requirement): every string in ${JSON.stringify(brief.exactText)} appears`,
        "   VERBATIM and perfectly spelled — reject for ANY misspelling, doubled/merged letters,",
        "   gibberish glyphs, or extra prominent text not in that list.",
        "2. The subject, style, palette, and composition match the brief.",
        "3. Any EXPLICIT directive in the user's request above (style, palette, mood, aspect",
        "   ratio, specific elements) is honored even if the brief softened or dropped it —",
        "   the user's own words outrank the brief where they conflict.",
        "If the file does not exist or cannot be viewed, fail it and say so in the feedback.",
        "When you reject, make the feedback actionable: name what is wrong and what to change.",
      ].join("\n"),
      { label: `validate:${round}`, phase: "Validate", schema: VERDICT, model: args.models?.validate },
    ),

  { attempts: args.attempts ?? 3 },
);

if (!outcome.ok) {
  log(`validator never approved after ${outcome.attempts} attempt(s) — returning the last image anyway`);
}

return {
  accepted: outcome.ok,
  attempts: outcome.attempts,
  imagePath: (outcome.value && outcome.value.imagePath) || lastImagePath || null,
  concept: brief.concept ?? null,
  exactText: brief.exactText,
};
