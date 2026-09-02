// Skeleton layout behavior against a folded event stream: sites start muted, instances
// attach by call path, loop iterations partition and select, foreign/pathless nodes land in
// the unmapped cluster, phases activate when reached.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEventLogRecord } from "@automatalabs/shared-types";

import { layoutSkeletonGraph, skeletonIsUseful } from "../ui/src/skeleton-graph.js";
import { extractSkeleton } from "../ui/src/skeleton.js";
import { createRunModel, foldRecord } from "../ui/src/state.js";

const SCRIPT = `export const meta = { name: 'layout-fixture', description: 'x', phases: [{ title: 'Research' }] }
phase('Research')
const notes = await parallel(['a', 'b'].map((t) => () => agent(\`Research \${t}\`, { label: \`research:\${t}\` })))
let dry = 0
while (dry < 2) {
  await agent('probe', { label: 'prober' })
  dry += 1
}
return notes`;

function record(seq: number, event: Record<string, unknown>): RunEventLogRecord {
  return {
    version: 1,
    streamId: "stream-1",
    runId: "run-1",
    seq,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    event,
  } as unknown as RunEventLogRecord;
}

function start(seq: number, callIndex: number, label: string, path?: string) {
  return record(seq, {
    type: "agentStart",
    runId: "run-1",
    scope: "run-1",
    label,
    prompt: "p",
    callIndex,
    ...(path === undefined ? {} : { path }),
  });
}

function end(seq: number, callIndex: number, label: string) {
  return record(seq, {
    type: "agentEnd",
    runId: "run-1",
    scope: "run-1",
    label,
    result: { preview: "ok", redacted: false, truncated: false },
    callIndex,
  });
}

const skeleton = extractSkeleton(SCRIPT);
if (skeleton === undefined) throw new Error("fixture skeleton must parse");
const siteKeys = [...skeleton.byKey.entries()];
const fanKey = siteKeys.find(([, site]) => site.labelPreview?.startsWith("research"))?.[0];
const loopKey = siteKeys.find(([, site]) => site.labelPreview === "prober")?.[0];
if (fanKey === undefined || loopKey === undefined) throw new Error("fixture sites missing");

test("an empty run renders the full muted skeleton", () => {
  assert.equal(skeletonIsUseful(skeleton), true);
  const model = createRunModel("run-1");
  const layout = layoutSkeletonGraph(skeleton, model, new Set(), new Map());

  const statuses = layout.placed.map((item) => `${item.kind}:${item.status}`);
  // The statically-known parallel fan-out occupies both planned slots before execution.
  assert.deepEqual(statuses, ["phase:pending", "site:pending", "site:pending", "site:pending"]);
  assert.equal(layout.loops.length, 1);
  assert.equal(layout.loops[0]?.iterations, 0);
  assert.equal(layout.unmatchedCount, 0);
  // The fan-out bracket announces its statically-known width.
  assert.deepEqual(layout.brackets.map((bracket) => bracket.label), ["parallel ×2"]);
});

test("instances attach to their sites and phases activate when reached", () => {
  const model = createRunModel("run-1");
  foldRecord(model, record(1, { type: "phase", runId: "run-1", scope: "run-1", title: "Research" }));
  foldRecord(model, start(2, 0, "research:a", `${fanKey}`));
  foldRecord(model, start(3, 1, "research:b", `${fanKey}`));
  const layout = layoutSkeletonGraph(skeleton, model, new Set(), new Map());

  const phase = layout.placed.find((item) => item.kind === "phase");
  assert.equal(phase?.status, "done");
  assert.equal(phase?.phaseIndex, 0);
  const instances = layout.placed.filter((item) => item.kind === "instance");
  assert.deepEqual(instances.map((item) => item.label).sort(), ["research:a", "research:b"]);
  assert.ok(instances.every((item) => item.status === "running"));
  // The loop site is still muted.
  const pendingSites = layout.placed.filter((item) => item.kind === "site");
  assert.equal(pendingSites.length, 1);
});

test("loop iterations partition by site-key repetition and are selectable", () => {
  const model = createRunModel("run-1");
  foldRecord(model, start(1, 0, "prober", `${loopKey}<9:9`));
  foldRecord(model, end(2, 0, "prober"));
  foldRecord(model, start(3, 1, "prober", `${loopKey}<9:9`));
  const layout = layoutSkeletonGraph(skeleton, model, new Set(), new Map());

  assert.equal(layout.loops[0]?.iterations, 2);
  assert.equal(layout.loops[0]?.shown, 1);
  const shown = layout.placed.filter((item) => item.kind === "instance");
  assert.deepEqual(shown.map((item) => item.callIndex), [1]);
  assert.equal(shown[0]?.status, "running");

  const first = layoutSkeletonGraph(skeleton, model, new Set(), new Map([["loop0", 0]]));
  const firstShown = first.placed.filter((item) => item.kind === "instance");
  assert.deepEqual(firstShown.map((item) => item.callIndex), [0]);
  assert.equal(firstShown[0]?.status, "done");
});

test("quality primitives render semantic containers, planned members, and gate feedback", () => {
  const qualityScript = `export const meta = { name: 'quality', description: 'x' }
const gated = await gate(
  (_feedback, attempt) => agent(\`draft \${attempt}\`, { label: \`draft:\${attempt}\` }),
  (draft) => agent(\`review \${draft}\`, { label: 'gate-review' }),
  { attempts: 3 },
)
const dry = await loopUntilDry({
  round: () => agent('hunt', { label: 'hunt' }).then((item) => [item]),
  consecutiveEmpty: 2,
  maxRounds: 7,
})
const checked = await verify('claim', { reviewers: 3, threshold: 0.66 })
const winner = await judgePanel(['a', 'b'], { judges: 2 })
return { gated, dry, checked, winner }`;
  const quality = extractSkeleton(qualityScript);
  if (quality === undefined) throw new Error("quality skeleton must parse");
  const model = createRunModel("run-1");
  const layout = layoutSkeletonGraph(quality, model, new Set(), new Map());

  assert.deepEqual(layout.loops.map((loop) => loop.mode), ["gate", "loopUntilDry"]);
  assert.equal(layout.loops[0]?.label, "GATE");
  assert.match(layout.loops[0]?.detail ?? "", /produce → validate · 3 max/);
  assert.match(layout.loops[1]?.detail ?? "", /2 dry to stop · 7 rounds max/);
  assert.deepEqual(layout.panels.map((panel) => panel.mode), ["verify", "judgePanel"]);
  assert.match(layout.panels[0]?.detail ?? "", /3 reviewers · pass ≥ 66%/);
  assert.match(layout.panels[1]?.detail ?? "", /2 candidates × 2 judges/);
  assert.equal(layout.edges.filter((edge) => edge.kind === "feedback").length, 1);

  const verifyPending = layout.placed.filter((item) => item.sub.startsWith("verify ·"));
  const judgePending = layout.placed.filter((item) => item.sub.startsWith("judgePanel ·"));
  assert.equal(verifyPending.length, 3);
  assert.equal(judgePending.length, 4);
});

test("quality panel fan-out composes with a statically-known parallel map", () => {
  const mappedScript = `export const meta = { name: 'mapped-panel', description: 'x' }
return await parallel([1, 2].map((claim) => () => verify(claim, { reviewers: 3 })))`;
  const mapped = extractSkeleton(mappedScript);
  if (mapped === undefined) throw new Error("mapped skeleton must parse");
  const layout = layoutSkeletonGraph(mapped, createRunModel("run-1"), new Set(), new Map());
  assert.equal(layout.panels.length, 1);
  assert.equal(layout.placed.filter((item) => item.sub.startsWith("verify ·")).length, 6);
  assert.ok(layout.brackets.some((bracket) => bracket.label === "parallel ×2"));
});

test("gate attempts page as producer/reviewer rounds", () => {
  const gateScript = `export const meta = { name: 'gate', description: 'x' }
return await gate(
  (_feedback, attempt) => agent(\`draft \${attempt}\`, { label: \`draft:\${attempt}\` }),
  (draft) => agent(\`review \${draft}\`, { label: 'gate-review' }),
  { attempts: 3 },
)`;
  const gateSkeleton = extractSkeleton(gateScript);
  if (gateSkeleton === undefined) throw new Error("gate skeleton must parse");
  const keys = [...gateSkeleton.byKey.values()];
  const draftKey = keys.find((site) => site.labelPreview?.startsWith("draft:"))?.key;
  const reviewKey = keys.find((site) => site.labelPreview === "gate-review")?.key;
  if (draftKey === undefined || reviewKey === undefined) throw new Error("gate sites missing");

  const model = createRunModel("run-1");
  foldRecord(model, start(1, 0, "draft:0", draftKey));
  foldRecord(model, end(2, 0, "draft:0"));
  foldRecord(model, start(3, 1, "gate-review", reviewKey));
  foldRecord(model, end(4, 1, "gate-review"));
  foldRecord(model, start(5, 2, "draft:1", draftKey));
  foldRecord(model, end(6, 2, "draft:1"));
  foldRecord(model, start(7, 3, "gate-review", reviewKey));

  const latest = layoutSkeletonGraph(gateSkeleton, model, new Set(), new Map());
  assert.equal(latest.loops[0]?.iterations, 2);
  assert.equal(latest.loops[0]?.shown, 1);
  assert.match(latest.loops[0]?.detail ?? "", /attempt 2 of 2 observed · 3 max/);
  assert.deepEqual(
    latest.placed.filter((item) => item.kind === "instance").map((item) => item.callIndex),
    [2, 3],
  );

  const first = layoutSkeletonGraph(gateSkeleton, model, new Set(), new Map([["loop0", 0]]));
  assert.deepEqual(
    first.placed.filter((item) => item.kind === "instance").map((item) => item.callIndex),
    [0, 1],
  );
});

test("checkpoint sites activate from settlement callRecords", () => {
  const script = `export const meta = { name: 'cp', description: 'x' }
await agent('work', { label: 'worker' })
const approved = await checkpoint('Ship it?', { kind: 'confirm' })
return approved`;
  const cpSkeleton = extractSkeleton(script);
  if (cpSkeleton === undefined) throw new Error("checkpoint skeleton must parse");
  const cpSite = [...cpSkeleton.byKey.values()].find((site) => site.kind === "checkpoint");
  if (cpSite === undefined) throw new Error("checkpoint site missing");

  const model = createRunModel("run-1");
  const before = layoutSkeletonGraph(cpSkeleton, model, new Set(), new Map());
  const mutedCp = before.placed.find((item) => item.sub === "checkpoint · pending");
  assert.equal(mutedCp?.status, "pending");
  assert.equal(mutedCp?.label, "Ship it?");

  foldRecord(model, record(1, {
    type: "callRecord",
    runId: "run-1",
    scope: "run-1",
    record: { index: 1, kind: "checkpoint", hash: "h", path: cpSite.key, outcome: "result", origin: "confirm" },
  }));
  const after = layoutSkeletonGraph(cpSkeleton, model, new Set(), new Map());
  const decided = after.placed.find((item) => item.sub.startsWith("checkpoint"));
  assert.equal(decided?.status, "done");
  assert.equal(decided?.sub, "checkpoint · decided");
});

test("agent callRecords backfill paths for streams recorded before agentStart carried them", () => {
  const model = createRunModel("run-1");
  foldRecord(model, start(1, 0, "research:a"));
  assert.equal(layoutSkeletonGraph(skeleton, model, new Set(), new Map()).unmatchedCount, 1);
  foldRecord(model, record(2, {
    type: "callRecord",
    runId: "run-1",
    scope: "run-1",
    record: { index: 0, kind: "agent", hash: "h", path: fanKey, outcome: "result", origin: "runner" },
  }));
  const layout = layoutSkeletonGraph(skeleton, model, new Set(), new Map());
  assert.equal(layout.unmatchedCount, 0);
  assert.equal(layout.placed.filter((item) => item.kind === "instance").length, 1);
});

test("pathless strays and nested-workflow agents land in labeled clusters", () => {
  const model = createRunModel("run-1");
  foldRecord(model, start(1, 0, "no-path"));
  foldRecord(model, record(2, {
    type: "agentStart",
    runId: "run-1",
    scope: "run-1-nested1",
    label: "child agent",
    prompt: "p",
    callIndex: 1,
    path: fanKey,
  }));
  const layout = layoutSkeletonGraph(skeleton, model, new Set(), new Map());

  assert.equal(layout.unmatchedCount, 2);
  const labels = layout.placed.filter((item) => item.kind === "instance").map((item) => item.label);
  assert.deepEqual(labels.sort(), ["child agent", "no-path"]);
  // The nested run's agents cluster under their own bracket, not the generic stray bucket
  // (a foreign-scope path is relative to a DIFFERENT script and must never match a site).
  assert.ok(layout.brackets.some((bracket) => bracket.label === "nested 1 · 1"));
  assert.ok(layout.brackets.some((bracket) => bracket.label === "unmapped · 1"));
});
