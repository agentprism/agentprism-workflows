// Dev-only preview harness: drives the real GraphView/DetailView with a simulated event
// stream so the panel can be eyeballed in a plain browser without an MCP Apps host.
// Served by `vite ui` at /preview.html; never part of the production build (the build's
// rollup input is run-monitor.html only).
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RunEventLogRecord } from "@automatalabs/shared-types";

import { DetailView } from "./DetailView.js";
import { fmtDuration, fmtTokens, shortRunId } from "./format.js";
import { GraphView } from "./GraphView.js";
import type { NodeSelection } from "./GraphView.js";
import { extractSkeleton } from "./skeleton.js";
import { agentCount, createRunModel, foldRecord } from "./state.js";
import type { RunModel } from "./state.js";
import "./style.css";

const DEMO_SCRIPT = `export const meta = {
  name: 'quality-control-review',
  description: 'demo run for the semantic skeleton preview',
  phases: [{ title: 'Research' }, { title: 'Quality control' }, { title: 'Synthesize' }],
}
phase('Research')
const notes = await parallel(['transports', 'auth', 'resumability'].map(
  (topic) => () => agent(\`Research \${topic}\`, { label: \`research:\${topic}\` }),
))
phase('Quality control')
const draft = await gate(
  (feedback, attempt) => agent(\`Draft attempt \${attempt}: \${feedback ?? ''}\`, { label: \`draft:\${attempt + 1}\` }),
  (result) => agent(\`Review \${result}\`, { label: 'gate-review' }),
  { attempts: 3 },
)
const findings = await loopUntilDry({
  round: (round) => agent(\`Hunt round \${round + 1}\`, { label: 'hunt' }).then((item) => [item]),
  consecutiveEmpty: 2,
  maxRounds: 6,
})
const audit = await verify(notes[0], { reviewers: 2, threshold: 0.5, lens: ['correctness', 'security'] })
const best = await judgePanel(['candidate-a', 'candidate-b'], { judges: 2, rubric: 'correctness' })
const approved = await checkpoint('Ship the synthesis?', { kind: 'confirm' })
phase('Synthesize')
return await agent(\`Synthesize: \${draft.value}, \${findings.length}, \${best.index}\`, { label: 'synthesize' })`;

const RUN_ID = "wf_preview-demo";
const skeleton = extractSkeleton(DEMO_SCRIPT);
if (skeleton === undefined) throw new Error("preview script must parse");

// Pick site keys from the extractor itself so the demo never hardcodes coordinates.
const sites = [...skeleton.byKey.values()];
const researchKey = sites.find((site) => site.labelPreview?.startsWith("research"))?.key ?? "";
const draftKey = sites.find((site) => site.labelPreview?.startsWith("draft:"))?.key ?? "";
const gateReviewKey = sites.find((site) => site.labelPreview === "gate-review")?.key ?? "";
const huntKey = sites.find((site) => site.labelPreview === "hunt")?.key ?? "";
const verifyKey = sites.find((site) => site.helper === "verify")?.key ?? "";
const judgeKey = sites.find((site) => site.helper === "judgePanel")?.key ?? "";
const checkpointKey = sites.find((site) => site.kind === "checkpoint")?.key ?? "";
const synthesizeKey = sites.find((site) => site.labelPreview === "synthesize")?.key ?? "";

let seq = 0;
function record(event: Record<string, unknown>): RunEventLogRecord {
  seq += 1;
  return {
    version: 1,
    streamId: "stream-preview",
    runId: RUN_ID,
    seq,
    timestamp: new Date(Date.now() - 120_000 + seq * 1500).toISOString(),
    event: { runId: RUN_ID, scope: RUN_ID, ...event },
  } as unknown as RunEventLogRecord;
}

function start(callIndex: number, label: string, path: string, model = "opus") {
  return record({ type: "agentStart", label, prompt: `prompt for ${label}`, callIndex, path, model });
}

function transcript(callIndex: number, entryIndex: number, entry: Record<string, unknown>) {
  return record({
    type: "agentTranscript",
    label: "x",
    callIndex,
    executionStartSeq: 1,
    entryIndex,
    revision: 1,
    operation: "upsert",
    entry,
  });
}

function end(callIndex: number, label: string, tokens: number) {
  return record({
    type: "agentEnd",
    label,
    result: { preview: `"${label} findings…"`, redacted: false, truncated: false },
    callIndex,
    tokens,
    usage: { total: tokens, cost: tokens / 1e6 },
    modelResolved: "claude-opus-5",
    backendId: "claude-code",
  });
}

const TIMELINE: RunEventLogRecord[] = [
  record({ type: "phase", title: "Research" }),
  start(0, "research:transports", researchKey),
  start(1, "research:auth", researchKey),
  start(2, "research:resumability", researchKey),
  transcript(0, 0, { kind: "text", text: "Reading the transport spec…" }),
  transcript(0, 1, { kind: "toolCall", toolName: "Read", text: "Read" }),
  transcript(0, 2, { kind: "toolResult", toolName: "Read", text: "streamable-http.md — 412 lines" }),
  end(1, "research:auth", 48_211),
  transcript(2, 0, { kind: "text", text: "Comparing resumability approaches…" }),
  end(0, "research:transports", 61_402),
  end(2, "research:resumability", 55_870),
  record({ type: "phase", title: "Quality control" }),
  // gate(): producer → reviewer, then a rejected verdict feeds back into a fresh attempt.
  start(3, "draft:1", draftKey, "sonnet"),
  end(3, "draft:1", 18_310),
  start(4, "gate-review", gateReviewKey),
  end(4, "gate-review", 9_882),
  start(5, "draft:2", draftKey, "sonnet"),
  end(5, "draft:2", 12_054),
  start(6, "gate-review", gateReviewKey),
  end(6, "gate-review", 7_113),
  // loopUntilDry(): the same round site repeats and can be paged in the control frame.
  start(7, "hunt", huntKey),
  end(7, "hunt", 11_004),
  start(8, "hunt", huntKey),
  end(8, "hunt", 9_772),
  // Engine-side panels attach every generated reviewer/judge to their semantic helper.
  start(9, "verify 1", verifyKey),
  start(10, "verify 2", verifyKey),
  end(9, "verify 1", 8_144),
  end(10, "verify 2", 7_961),
  start(11, "judge 1.1", judgeKey),
  start(12, "judge 1.2", judgeKey),
  start(13, "judge 2.1", judgeKey),
  start(14, "judge 2.2", judgeKey),
  end(11, "judge 1.1", 5_201),
  end(12, "judge 1.2", 4_992),
  end(13, "judge 2.1", 5_108),
  end(14, "judge 2.2", 5_041),
  // Human checkpoint: run pauses, a decision arrives, the site lights up.
  record({
    type: "paused",
    reason: "checkpoint_required",
    checkpointContext: { callIndex: 15, hash: "h", prompt: "Ship the synthesis?", kind: "confirm" },
  }),
  record({ type: "resumed" }),
  record({
    type: "callRecord",
    record: { index: 15, kind: "checkpoint", hash: "h", path: checkpointKey, outcome: "result", origin: "confirm" },
  }),
  record({ type: "phase", title: "Synthesize" }),
  start(16, "synthesize", synthesizeKey),
  transcript(16, 0, { kind: "text", text: "Merging the approved results…" }),
  end(16, "synthesize", 71_226),
  record({ type: "tokenUsage", usage: { total: 372_910, cost: 0.3729 } }),
  record({
    type: "complete",
    summary: {
      status: "completed",
      workflowName: "quality-control-review",
      agentCount: 17,
      durationMs: 52_000,
      phaseCount: 3,
      callCount: 18,
      tokenUsage: { total: 372_910, cost: 0.3729 },
      result: { preview: '"shipped"', redacted: false, truncated: false },
    },
  }),
];

const STEP_MS = 1200;
const RESTART_PAUSE_MS = 5000;

function usePreviewModel(): { model: RunModel } {
  const modelRef = useRef<RunModel>(createRunModel(RUN_ID));
  const foldedRef = useRef(0);
  const epochRef = useRef(Date.now());
  const [, setVersion] = useState(0);
  useEffect(() => {
    // Steps are derived from elapsed time, not tick counts: background tabs throttle
    // timers, and a time-based fold catches up in a single fire when focus returns.
    const timer = setInterval(() => {
      const elapsed = Date.now() - epochRef.current;
      if (foldedRef.current >= TIMELINE.length) {
        if (elapsed >= TIMELINE.length * STEP_MS + RESTART_PAUSE_MS) {
          modelRef.current = createRunModel(RUN_ID);
          foldedRef.current = 0;
          epochRef.current = Date.now();
        }
      } else {
        const due = Math.min(Math.floor(elapsed / STEP_MS), TIMELINE.length);
        while (foldedRef.current < due) {
          const recordToFold = TIMELINE[foldedRef.current];
          foldedRef.current += 1;
          if (recordToFold !== undefined) {
            foldRecord(modelRef.current, recordToFold);
            modelRef.current.status =
              recordToFold.event.type === "complete" ? "completed" : "running";
          }
        }
      }
      setVersion((version) => version + 1);
    }, 400);
    return () => clearInterval(timer);
  }, []);
  return { model: modelRef.current };
}

function Preview() {
  const { model } = usePreviewModel();
  const [view, setView] = useState<{ kind: "graph" } | { kind: "detail"; target: NodeSelection }>({
    kind: "graph",
  });
  const [expandedWaves, setExpandedWaves] = useState<ReadonlySet<string>>(new Set());
  const [loopSelections, setLoopSelections] = useState<ReadonlyMap<string, number>>(new Map());
  const usage = model.usage;
  const memoSkeleton = useMemo(() => skeleton, []);

  return (
    <>
      <header className="bar top">
        <span className="wf-name">{model.name ?? "quality-control-review"}</span>
        <span className="run-id">run {shortRunId(model.runId)}</span>
        <span className="run-id">{agentCount(model)} agents</span>
        {model.status === "completed" ? (
          <span className="chip chip-ok">✓ Completed</span>
        ) : (
          <span className="chip chip-live">
            <span className="pulse" />
            Running
          </span>
        )}
        <span className="elapsed">
          {model.startTs !== undefined && model.endTs !== undefined
            ? fmtDuration(model.endTs - model.startTs)
            : ""}
        </span>
        <span className="spacer" />
        <span className="conn-lost">preview harness — simulated stream</span>
      </header>
      {view.kind === "graph" ? (
        <GraphView
          model={model}
          skeleton={memoSkeleton}
          expandedWaves={expandedWaves}
          onExpandWave={(key) => setExpandedWaves((current) => new Set([...current, key]))}
          loopSelections={loopSelections}
          onSelectLoopIteration={(loopId, iteration) =>
            setLoopSelections((current) => new Map([...current, [loopId, iteration]]))
          }
          onSelect={(target) => setView({ kind: "detail", target })}
        />
      ) : (
        <DetailView model={model} target={view.target} onBack={() => setView({ kind: "graph" })} />
      )}
      <footer className="bar bottom">
        <span className="hint">
          {view.kind === "graph" ? "Select a node to inspect" : ""}
        </span>
        <span className="spacer" />
        {usage !== undefined && (
          <span className="totals">
            <strong>{fmtTokens(usage.total)}</strong> tok
          </span>
        )}
      </footer>
    </>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
