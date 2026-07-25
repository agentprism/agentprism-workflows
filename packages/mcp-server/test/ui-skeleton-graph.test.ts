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
  assert.deepEqual(statuses, ["phase:pending", "site:pending", "site:pending"]);
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
  const mutedCp = before.placed.find((item) => item.sub === "checkpoint");
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
  assert.ok(layout.brackets.some((bracket) => bracket.label === "▸ nested 1 · 1"));
  assert.ok(layout.brackets.some((bracket) => bracket.label === "unmapped · 1"));
});
