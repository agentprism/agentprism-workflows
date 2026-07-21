export const meta = {
  name: "acp-backend-redesign",
  description:
    "Map how a new built-in ACP server is integrated today (claude/codex/opencode/pi), then design an architecture that makes adding first-class ACP server support much simpler. Read-only: agents read, reason, and design — no file changes.",
  phases: [
    { title: "Map" },       // codex explorers inventory today's integration surface
    { title: "Design" },    // kimi synthesizes the redesign from the full inventory
    { title: "Challenge" }, // codex adversarially verifies the design against the code
    { title: "Finalize" },  // kimi revises against verified critique
  ],
};

// ---------------------------------------------------------------------------
// Source contract: the user's verbatim request travels with the run.
// ---------------------------------------------------------------------------

const SOURCE_REQUEST =
  (args && typeof args === "object" && !Array.isArray(args) && typeof args.sourceRequest === "string"
    ? args.sourceRequest
    : null) ||
  "Understand the process of adding first-class support for a built-in ACP server (alongside the " +
  "existing claude/codex/opencode/pi acp integrations), in order to design a new architecture " +
  "that makes adding first-class ACP server support much simpler. The workflow agents shouldn't " +
  "be making any file changes, just reading, reasoning, and designing what a better architecture " +
  "would look like.";

const REPO = cwd; // the run's base working directory — this monorepo

// ---------------------------------------------------------------------------
// Model routing (ids verified against the live advertised catalogs):
//   Kimi:  pi/openrouter/moonshotai/kimi-k3 + thinkingLevel "high"
//   Codex: codex/gpt-5.6-sol + reasoning_effort "xhigh" + fast-mode true, read-only mode
// ---------------------------------------------------------------------------

const KIMI = {
  model: "pi/openrouter/moonshotai/kimi-k3",
  configOptions: { thinkingLevel: "high" },
};

const CODEX = {
  model: "codex/gpt-5.6-sol",
  mode: "read-only",
  configOptions: { "fast-mode": true, reasoning_effort: "xhigh" },
};

const READ_ONLY_RULES =
  "HARD CONSTRAINTS: This is a read-only investigation. Do NOT create, edit, move, or delete any " +
  "file. Do NOT run formatters, code-mods, builds that write artifacts, or git mutations. Read " +
  "files, grep, and reason only. Populate every schema field from code you actually read — never " +
  "emit placeholder values like 'TODO' or 'unknown'. If a cited file does not exist as cited, " +
  "say so explicitly in your report instead of guessing.";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const MAP_REPORT = {
  type: "object",
  additionalProperties: false,
  required: ["area", "summary", "touchPoints", "couplingNotes"],
  properties: {
    area: {
      type: "string",
      description: "The investigation area exactly as assigned in the prompt.",
    },
    summary: {
      type: "string",
      description:
        "At most 12 sentences: what this area does today and exactly what adding a new built-in " +
        "ACP backend requires here, grounded in code you read.",
    },
    touchPoints: {
      type: "array",
      description:
        "Every file/symbol a developer must touch or understand to add a new built-in backend in " +
        "this area. At most 12 entries, most load-bearing first.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "symbol", "role"],
        properties: {
          path: {
            type: "string",
            description: "Repo-relative path copied exactly from the repository — never invented.",
          },
          symbol: {
            type: "string",
            description: "Exact exported symbol, function, type, or switch/registry entry involved.",
          },
          role: {
            type: "string",
            description:
              "At most 2 sentences: what must change or be understood here when adding a backend.",
          },
        },
      },
    },
    couplingNotes: {
      type: "array",
      description:
        "At most 8 observations about coupling that makes adding a backend harder than it should " +
        "be (scatter, special-casing, per-backend branches, duplicated wiring).",
      items: { type: "string" },
    },
  },
};

const ARCHITECTURE = {
  type: "object",
  additionalProperties: false,
  required: [
    "currentProcess",
    "painPoints",
    "proposedArchitecture",
    "stepsBefore",
    "stepsAfter",
    "migrationPath",
    "risks",
    "answeredCritiques",
  ],
  properties: {
    currentProcess: {
      type: "array",
      description:
        "The end-to-end steps required TODAY to add a new built-in ACP server, in order, each " +
        "naming the file(s) involved. Derived from the explorer inventory, not from imagination.",
      items: { type: "string" },
    },
    painPoints: {
      type: "array",
      description:
        "At most 10 pain points in today's process, each citing the concrete coupling it comes from.",
      items: { type: "string" },
    },
    proposedArchitecture: {
      type: "array",
      description:
        "The redesign: at most 10 components/decisions. Each entry names the new or changed " +
        "abstraction, where it lives, and how a new backend plugs into it (ideally one " +
        "declarative descriptor + one adapter).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "location", "design"],
        properties: {
          name: { type: "string", description: "Name of the component or design decision." },
          location: {
            type: "string",
            description: "Package/file where it would live (new paths allowed, clearly marked as new).",
          },
          design: {
            type: "string",
            description:
              "At most 5 sentences: the shape of the abstraction and how it absorbs a per-backend " +
              "concern that is scattered today.",
          },
        },
      },
    },
    stepsBefore: {
      type: "number",
      description: "Count of discrete touch points to add a backend today, from currentProcess.",
    },
    stepsAfter: {
      type: "number",
      description: "Count of discrete touch points under the proposed architecture.",
    },
    migrationPath: {
      type: "array",
      description:
        "Ordered migration steps from today's code to the new architecture, keeping the four " +
        "existing backends working at every step.",
      items: { type: "string" },
    },
    risks: {
      type: "array",
      description: "At most 8 honest risks or trade-offs of the redesign.",
      items: { type: "string" },
    },
    answeredCritiques: {
      type: "array",
      description:
        "One entry per critique carried into this revision: what changed in the design because of " +
        "it, or why it was rejected with evidence. Empty on the first (unchallenged) draft.",
      items: { type: "string" },
    },
  },
};

const CRITIQUE = {
  type: "object",
  additionalProperties: false,
  required: ["lensQuestion", "verdict", "claims"],
  properties: {
    lensQuestion: {
      type: "string",
      description: "The single falsifiable lens question exactly as assigned.",
    },
    verdict: {
      type: "string",
      enum: ["holds", "partially-holds", "refuted"],
      description: "Whether the design survives this lens when checked against the actual code.",
    },
    claims: {
      type: "array",
      description:
        "At most 8 load-bearing claims from the design that you checked against the repository.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "evidence", "verified"],
        properties: {
          claim: { type: "string", description: "The claim, quoted or tightly paraphrased." },
          evidence: {
            type: "string",
            description:
              "At most 3 sentences: file:symbol evidence from code you actually read supporting " +
              "or refuting the claim. Cite exact paths.",
          },
          verified: {
            type: "boolean",
            description: "True only when the evidence confirms the claim as stated.",
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Phase 1 — Map: parallel read-only explorers inventory today's surface
// ---------------------------------------------------------------------------

phase("Map");

const EXPLORER_AREAS = [
  {
    key: "registry-backend-contract",
    brief:
      "Read packages/acp-agents/src/registry.ts, backend.ts, capabilities.ts, pool.ts, and every " +
      "file under packages/acp-agents/src/backends/. Document the backend contract (interface, " +
      "lifecycle, spawn/auth wiring), how the four built-in backends (claude, codex, opencode, pi) " +
      "are registered and constructed, and every place a backend name is hard-coded.",
  },
  {
    key: "runner-and-structured-output",
    brief:
      "Read packages/acp-agents/src/runner.ts, acp-client.ts, client-handlers.ts, " +
      "structured-output.ts, structured-tool.ts, schema-strict.ts, and prompt.ts. Document how a " +
      "session is opened and driven per backend, and how the structured-output channel is selected " +
      "per backend (native outputFormat vs outputSchema vs injected StructuredOutput MCP tool vs " +
      "prompt fallback) — i.e. every per-backend branch a new backend must slot into.",
  },
  {
    key: "engine-routing-and-validation",
    brief:
      "Read packages/workflow-engine/src and packages/workflows/src (including the validate " +
      "command and the harness config probe). Document how a model spec string is routed to a " +
      "backend (first-segment matching), how configOptions are validated against advertised " +
      "catalogs, how mode is enforced, and what the validator/config commands must learn when a " +
      "new built-in backend appears.",
  },
  {
    key: "distribution-and-docs-surface",
    brief:
      "Read packages/mcp-server/src, packages/acp-agents/src/auth/ and provider-store.ts, plus " +
      "top-level docs/ and skills/ references to backends. Document everything outside the core " +
      "runtime a new built-in backend must touch: env knobs (AGENTPRISM_*), default-backend " +
      "vocabularies, auth documentation, MCP server wiring, and per-backend spawn overrides.",
  },
];

const explorers = (
  await parallel(
    EXPLORER_AREAS.map((area) => () =>
      agent(
        `You are mapping part of the monorepo at ${REPO} (packages: acp-agents, workflow-engine, ` +
        `mcp-server, workflows, shared-types).\n\n` +
        `OVERALL GOAL (the user's verbatim request): "${SOURCE_REQUEST}"\n\n` +
        `YOUR ASSIGNED AREA: "${area.key}".\n${area.brief}\n\n` +
        `Report only what your area requires when adding a NEW built-in backend. ` +
        READ_ONLY_RULES,
        {
          label: `map:${area.key}`,
          phase: "Map",
          schema: MAP_REPORT,
          retries: 1,
          ...CODEX,
          resume: { filesystem: "read-only" },
        },
      ),
    ),
  )
).filter(Boolean);

log(`Map phase: ${explorers.length}/${EXPLORER_AREAS.length} explorers reported.`);

if (explorers.length < 2) {
  // Not enough grounded inventory to design against — surface the shortfall
  // instead of letting the designer hallucinate the missing areas.
  return {
    status: "insufficient-inventory",
    sourceRequest: SOURCE_REQUEST,
    explorersReporting: explorers.length,
    inventory: explorers,
  };
}

const inventoryJson = JSON.stringify(explorers, null, 2);

// ---------------------------------------------------------------------------
// Human gate: review the Map inventory before spending the Design/Challenge/
// Finalize calls. Live channel prompts interactively; headless pauses durably
// (resume with checkpointReplies). Declining returns the raw inventory.
// ---------------------------------------------------------------------------

const inventoryDigest = explorers
  .map(
    (e) =>
      `- ${e.area}: ${e.touchPoints.length} touch point(s), top coupling note: ${
        e.couplingNotes[0] || "(none reported)"
      }`,
  )
  .join("\n");

const proceed = await checkpoint(
  `Map phase complete — ${explorers.length}/${EXPLORER_AREAS.length} explorers reported on how ` +
    `built-in ACP backends are integrated today:\n${inventoryDigest}\n\n` +
    `Continue to the Design phase (Kimi drafts the new architecture from this inventory)?`,
  { kind: "confirm", default: true, headless: "pause" },
);

if (!proceed) {
  return {
    status: "stopped-at-inventory-review",
    sourceRequest: SOURCE_REQUEST,
    inventory: explorers,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — Design: kimi synthesizes the redesign from the full inventory
// ---------------------------------------------------------------------------

phase("Design");

const designPrompt = (critiqueSection) =>
  `You are the lead architect for the monorepo at ${REPO}. Read any file you need to check a ` +
  `detail, but your design must be grounded in the explorer inventory below.\n\n` +
  `THE USER'S VERBATIM REQUEST (hop zero — judge your design against this, not against the ` +
  `inventory): "${SOURCE_REQUEST}"\n\n` +
  `EXPLORER INVENTORY of how today's four built-in ACP backends (claude, codex, opencode, pi) ` +
  `are integrated:\n${inventoryJson}\n\n` +
  `Design the target architecture: a way to add a new first-class built-in ACP server that is ` +
  `dramatically simpler than today's process — ideally one declarative backend descriptor plus a ` +
  `thin adapter, with per-backend special-casing (structured-output channel, routing, validation, ` +
  `auth, env knobs) folded into the descriptor. Give the before/after touch-point counts honestly ` +
  `(stepsBefore/stepsAfter), an incremental migration path that keeps all four existing backends ` +
  `green, and the real risks.\n` +
  critiqueSection +
  READ_ONLY_RULES;

const draft = await agent(designPrompt(""), {
  label: "design:draft",
  phase: "Design",
  schema: ARCHITECTURE,
  retries: 1,
  ...KIMI,
  resume: { filesystem: "read-only" },
});

if (!draft) {
  return {
    status: "design-failed",
    sourceRequest: SOURCE_REQUEST,
    inventory: explorers,
  };
}

// ---------------------------------------------------------------------------
// Human gate: review the draft architecture before spending the adversarial
// Challenge lenses and the Finalize revision. Declining returns the draft.
// ---------------------------------------------------------------------------

const draftDigest =
  `Draft claims ${draft.stepsBefore} touch points today -> ${draft.stepsAfter} under the ` +
  `proposal. Pain points: ${draft.painPoints.length}. Proposed components:\n` +
  draft.proposedArchitecture.map((c) => `- ${c.name} (${c.location})`).join("\n");

const proceedToChallenge = await checkpoint(
  `Design phase complete — Kimi's draft architecture is ready.\n${draftDigest}\n\n` +
    `Continue to the Challenge phase (3 adversarial codex lenses verify the draft against the ` +
    `actual code, then Kimi finalizes)?`,
  { kind: "confirm", default: true, headless: "pause" },
);

if (!proceedToChallenge) {
  return {
    status: "stopped-at-design-review",
    sourceRequest: SOURCE_REQUEST,
    architecture: draft,
    inventory: explorers,
  };
}

// ---------------------------------------------------------------------------
// Phase 3 — Challenge: cross-vendor adversarial lenses, verified against code
// ---------------------------------------------------------------------------

phase("Challenge");

const LENSES = [
  "FALSIFIABLE LENS QUESTION: Does every concrete touch-point the design cites (file, symbol, " +
    "registry entry, env knob) actually exist in the repository as cited? Refute by finding cited " +
    "surfaces that are missing, renamed, or in a different package.",
  "FALSIFIABLE LENS QUESTION: Does the proposed architecture actually REMOVE coupling, or merely " +
    "relocate it? Refute by finding per-backend special-casing (structured-output channel " +
    "selection, mode vocabularies, routing first-segments, auth flows) that the design leaves " +
    "scattered or pushes onto backend authors unchanged.",
  "FALSIFIABLE LENS QUESTION: Does the design serve the user's verbatim request — a MUCH SIMPLER " +
    "process for adding first-class built-in ACP server support? Refute by showing the " +
    "stepsAfter count or migration path hides work (docs, validator catalogs, MCP wiring, auth " +
    "docs) that stepsBefore counted.",
];

const draftJson = JSON.stringify(draft, null, 2);

const critiques = (
  await parallel(
    LENSES.map((lens, i) => () =>
      agent(
        `You are an adversarial reviewer with full read access to the monorepo at ${REPO}. Try to ` +
        `REFUTE the design below under your assigned lens. Check claims against the actual code — ` +
        `open every cited file.\n\n` +
        `THE USER'S VERBATIM REQUEST: "${SOURCE_REQUEST}"\n\n` +
        `${lens}\n\n` +
        `DESIGN UNDER REVIEW:\n${draftJson}\n\n` +
        `Report each load-bearing claim you checked with file:symbol evidence. ` +
        READ_ONLY_RULES,
        {
          label: `challenge:lens-${i + 1}`,
          phase: "Challenge",
          schema: CRITIQUE,
          retries: 1,
          ...CODEX,
          resume: { filesystem: "read-only" },
        },
      ),
    ),
  )
).filter(Boolean);

log(`Challenge phase: ${critiques.length}/${LENSES.length} lenses reported.`);

// ---------------------------------------------------------------------------
// Phase 4 — Finalize: kimi revises against the verified critique
// ---------------------------------------------------------------------------

phase("Finalize");

const refuted = critiques.filter((c) => c.verdict !== "holds");

const final =
  critiques.length === 0
    ? draft // no challenge survived to answer; keep the verified-against-inventory draft
    : await agent(
        designPrompt(
          `ADVERSARIAL CRITIQUE of your first draft (each claim was checked against the code by an ` +
          `independent reviewer). Revise the design so every verified-false claim is fixed and ` +
          `every 'refuted'/'partially-holds' verdict is resolved; record what changed (or why you ` +
          `reject a point, with evidence) in answeredCritiques:\n` +
          `${JSON.stringify(critiques, null, 2)}\n\n` +
          `Your first draft was:\n${draftJson}\n\n`,
        ),
        {
          label: "design:final",
          phase: "Finalize",
          schema: ARCHITECTURE,
          retries: 1,
          ...KIMI,
          resume: { filesystem: "read-only" },
        },
      );

if (!final) {
  return {
    status: "finalize-failed-returning-draft",
    sourceRequest: SOURCE_REQUEST,
    architecture: draft,
    critiques,
  };
}

return {
  status: "complete",
  sourceRequest: SOURCE_REQUEST,
  simplification: { stepsBefore: final.stepsBefore, stepsAfter: final.stepsAfter },
  architecture: final,
  critiques,
  refutedLensCount: refuted.length,
  inventory: explorers,
};
