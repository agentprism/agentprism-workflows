// Skeleton-driven graph layout: the script's static structure (phases, call sites,
// parallel/pipeline groups, loop containers) is drawn from t=0 with unexecuted sites muted,
// and runtime NodeModels attach to sites by the innermost component of their call path.
// Loops show one iteration at a time (latest by default, selectable); iteration boundaries
// are derived by walking a loop's instances in callIndex order and starting a new iteration
// whenever a site key repeats. Pure geometry — rendering lives in GraphView.tsx.
import { NODE_H, NODE_W, PHASE_W } from "./graph.js";
import { innermostKey } from "./skeleton.js";
import type { Skeleton, SkeletonNode, SkeletonSite } from "./skeleton.js";
import type { NodeModel, NodeStatus, RunModel } from "./state.js";

const H_GAP = 92;
const V_GAP = 36;
const PADDING = 44;
const LOOP_PAD = 26;
const LOOP_HEAD = 38;
const STAGE_GAP = 56;
const MAX_VISIBLE_STACK = 6;

export type SkelStatus = "pending" | NodeStatus;

export interface SkelPlacedNode {
  /** Stable React key. */
  id: string;
  kind: "phase" | "instance" | "site" | "more";
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub: string;
  status: SkelStatus;
  callIndex?: number;
  /** Index into RunModel.phases when the phase has been reached; absent otherwise. */
  phaseIndex?: number;
  siteKey?: string;
}

export interface SkelLoopBox {
  loopId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  iterations: number;
  /** 0-based index of the iteration currently displayed. */
  shown: number;
}

export interface SkelBracket {
  x: number;
  yTop: number;
  yBottom: number;
  label: string;
}

export interface SkelEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SkelLayout {
  width: number;
  height: number;
  placed: SkelPlacedNode[];
  loops: SkelLoopBox[];
  brackets: SkelBracket[];
  edges: SkelEdge[];
  /** Instances that could not be attached to any site (no path, foreign scope, alias). */
  unmatchedCount: number;
}

/** A skeleton with no keyed call sites cannot improve on the wave view. */
export function skeletonIsUseful(skeleton: Skeleton): boolean {
  return skeleton.byKey.size > 0;
}

interface Box {
  w: number;
  h: number;
  placed: SkelPlacedNode[];
  loops: SkelLoopBox[];
  brackets: SkelBracket[];
  edges: SkelEdge[];
}

function emptyBox(): Box {
  return { w: 0, h: 0, placed: [], loops: [], brackets: [], edges: [] };
}

function shift(box: Box, dx: number, dy: number): void {
  for (const item of box.placed) {
    item.x += dx;
    item.y += dy;
  }
  for (const loop of box.loops) {
    loop.x += dx;
    loop.y += dy;
  }
  for (const bracket of box.brackets) {
    bracket.x += dx;
    bracket.yTop += dy;
    bracket.yBottom += dy;
  }
  for (const edge of box.edges) {
    edge.x1 += dx;
    edge.y1 += dy;
    edge.x2 += dx;
    edge.y2 += dy;
  }
}

function merge(into: Box, from: Box): void {
  into.placed.push(...from.placed);
  into.loops.push(...from.loops);
  into.brackets.push(...from.brackets);
  into.edges.push(...from.edges);
}

interface LayoutContext {
  model: RunModel;
  /** Instances currently visible per site key (loop sites: the shown iteration only). */
  visibleInstances: Map<string, NodeModel[]>;
  /** Total instances per site key regardless of iteration, for fan-out labels. */
  allInstances: Map<string, NodeModel[]>;
  expanded: ReadonlySet<string>;
  loopMeta: Map<string, { iterations: number; shown: number }>;
  nextLoopId: () => string;
  nextPhaseId: () => string;
}

function instanceNode(node: NodeModel, x: number, y: number): SkelPlacedNode {
  return {
    id: `a${node.callIndex}`,
    kind: "instance",
    x,
    y,
    w: NODE_W,
    h: NODE_H,
    label: node.label,
    sub: node.model ?? node.backendId ?? "agent",
    status: node.status,
    callIndex: node.callIndex,
  };
}

function layoutSite(site: SkeletonSite, context: LayoutContext): Box {
  const box = emptyBox();
  if (site.kind === "checkpoint") return layoutCheckpointSite(site, context);
  const instances = context.visibleInstances.get(site.key) ?? [];
  if (instances.length === 0) {
    box.placed.push({
      id: `s${site.key}`,
      kind: "site",
      x: 0,
      y: 0,
      w: NODE_W,
      h: NODE_H,
      label: site.labelPreview ?? site.promptPreview ?? `${site.helper ?? site.kind}()`,
      sub: site.kind === "agent" ? "pending" : (site.helper ?? site.kind),
      status: "pending",
      siteKey: site.key,
    });
    box.w = NODE_W;
    box.h = NODE_H;
    return box;
  }
  const visible = context.expanded.has(site.key) ? instances : instances.slice(0, MAX_VISIBLE_STACK);
  let y = 0;
  for (const node of visible) {
    box.placed.push(instanceNode(node, 0, y));
    y += NODE_H + V_GAP;
  }
  const hidden = instances.length - visible.length;
  if (hidden > 0) {
    box.placed.push({
      id: `m${site.key}`,
      kind: "more",
      x: 0,
      y,
      w: NODE_W,
      h: NODE_H,
      label: `+${hidden} more`,
      sub: "agents",
      status: "pending",
      siteKey: site.key,
    });
    y += NODE_H + V_GAP;
  }
  box.w = NODE_W;
  box.h = y - V_GAP;
  return box;
}

/**
 * Checkpoints emit no agentStart; their settlement callRecords carry the path. The site
 * stays muted until at least one decision lands, then shows the latest outcome. Checkpoint
 * cards are not iteration-partitioned (a same-site repeat inside a loop shows its most
 * recent decision).
 */
function layoutCheckpointSite(site: SkeletonSite, context: LayoutContext): Box {
  const box = emptyBox();
  const decisions = [...context.model.checkpoints.values()]
    .filter(
      (checkpoint) =>
        checkpoint.path !== undefined &&
        innermostKey(checkpoint.path) === site.key &&
        (checkpoint.scope === undefined || checkpoint.scope === context.model.runId),
    )
    .sort((left, right) => left.callIndex - right.callIndex);
  const latest = decisions.at(-1);
  const label = site.promptPreview ?? site.labelPreview ?? "checkpoint()";
  if (latest === undefined) {
    box.placed.push({
      id: `s${site.key}`,
      kind: "site",
      x: 0,
      y: 0,
      w: NODE_W,
      h: NODE_H,
      label,
      sub: "checkpoint",
      status: "pending",
      siteKey: site.key,
    });
  } else {
    box.placed.push({
      id: `c${latest.callIndex}`,
      kind: "site",
      x: 0,
      y: 0,
      w: NODE_W,
      h: NODE_H,
      label,
      sub: decisions.length > 1 ? `checkpoint · ${decisions.length} decisions` : "checkpoint · decided",
      status: latest.outcome === "error" ? "error" : "done",
      siteKey: site.key,
    });
  }
  box.w = NODE_W;
  box.h = NODE_H;
  return box;
}

function groupObservedCount(node: SkeletonNode, context: LayoutContext): number {
  if (node.kind === "site") return (context.allInstances.get(node.site.key) ?? []).length;
  if (node.kind === "group" || node.kind === "loop") {
    return node.children.reduce((sum, child) => sum + groupObservedCount(child, context), 0);
  }
  return 0;
}

function layoutNode(node: SkeletonNode, context: LayoutContext): Box | undefined {
  switch (node.kind) {
    case "phase": {
      const box = emptyBox();
      const reached = node.title !== undefined && context.model.phases.includes(node.title);
      const phaseIndex = reached ? context.model.phases.indexOf(node.title ?? "") : undefined;
      box.placed.push({
        id: context.nextPhaseId(),
        kind: "phase",
        x: 0,
        y: 0,
        w: PHASE_W,
        h: NODE_H,
        label: node.title ?? "phase",
        sub: "phase",
        status: reached ? "done" : "pending",
        ...(phaseIndex !== undefined && phaseIndex >= 0 ? { phaseIndex } : {}),
      });
      box.w = PHASE_W;
      box.h = NODE_H;
      return box;
    }
    case "site":
      return layoutSite(node.site, context);
    case "group": {
      const inner =
        node.mode === "pipeline" && node.stages !== undefined && node.stages.length > 0
          ? layoutRow(
              node.stages.map((stage) => layoutColumn(stage, context)),
              STAGE_GAP,
            )
          : layoutColumn(node.children, context);
      if (inner.placed.length === 0) return undefined;
      const observed = groupObservedCount(node, context);
      const count = node.staticCount ?? (observed > 0 ? observed : undefined);
      const label = `${node.mode}${count !== undefined ? ` ×${count}` : ""}`;
      inner.brackets.push({ x: -18, yTop: -6, yBottom: inner.h + 6, label });
      return inner;
    }
    case "loop": {
      const loopId = context.nextLoopId();
      const inner = layoutColumnAsSequence(node.children, context);
      if (inner.placed.length === 0) return undefined;
      const meta = context.loopMeta.get(loopId) ?? { iterations: 0, shown: 0 };
      const box = emptyBox();
      shift(inner, LOOP_PAD, LOOP_HEAD);
      merge(box, inner);
      box.w = inner.w + LOOP_PAD * 2;
      box.h = inner.h + LOOP_HEAD + LOOP_PAD;
      box.loops.push({
        loopId,
        x: 0,
        y: 0,
        w: box.w,
        h: box.h,
        iterations: meta.iterations,
        shown: meta.shown,
      });
      return box;
    }
  }
}

/** Vertical stack (parallel members, one pipeline stage). */
function layoutColumn(nodes: SkeletonNode[], context: LayoutContext): Box {
  const box = emptyBox();
  let y = 0;
  let width = 0;
  for (const node of nodes) {
    const child = layoutNode(node, context);
    if (child === undefined || child.placed.length === 0) continue;
    shift(child, 0, y);
    merge(box, child);
    y += child.h + V_GAP;
    width = Math.max(width, child.w);
  }
  box.w = width;
  box.h = Math.max(0, y - V_GAP);
  return box;
}

/** Horizontal arrangement of prebuilt boxes, vertically centered, no edges. */
function layoutRow(boxes: Box[], gap: number): Box {
  const out = emptyBox();
  const height = Math.max(0, ...boxes.map((box) => box.h));
  let x = 0;
  for (const box of boxes) {
    if (box.placed.length === 0) continue;
    shift(box, x, (height - box.h) / 2);
    merge(out, box);
    x += box.w + gap;
  }
  out.w = Math.max(0, x - gap);
  out.h = height;
  return out;
}

/** Horizontal sequence with connector edges between adjacent members. */
function layoutColumnAsSequence(nodes: SkeletonNode[], context: LayoutContext): Box {
  const boxes: Box[] = [];
  for (const node of nodes) {
    const child = layoutNode(node, context);
    if (child !== undefined && child.placed.length > 0) boxes.push(child);
  }
  return connectSequence(boxes);
}

function connectSequence(boxes: Box[]): Box {
  const out = emptyBox();
  const height = Math.max(0, ...boxes.map((box) => box.h));
  let x = 0;
  let previous: { x: number; w: number; centerY: number } | undefined;
  for (const box of boxes) {
    const y = (height - box.h) / 2;
    shift(box, x, y);
    merge(out, box);
    const centerY = y + box.h / 2;
    if (previous !== undefined) {
      out.edges.push({
        x1: previous.x + previous.w,
        y1: previous.centerY,
        x2: x,
        y2: centerY,
      });
    }
    previous = { x, w: box.w, centerY };
    x += box.w + H_GAP;
  }
  out.w = Math.max(0, x - H_GAP);
  out.h = height;
  return out;
}

/**
 * Assign loop ids in the same DFS order layout visits them, and compute per-loop iteration
 * partitions. A site belongs to its nearest enclosing loop; nested inner loops partition
 * independently of their parent.
 */
function computeLoopData(
  skeleton: Skeleton,
  bySite: Map<string, NodeModel[]>,
  loopSelections: ReadonlyMap<string, number>,
): {
  loopMeta: Map<string, { iterations: number; shown: number }>;
  visibleInstances: Map<string, NodeModel[]>;
} {
  const loopMeta = new Map<string, { iterations: number; shown: number }>();
  const visibleInstances = new Map<string, NodeModel[]>(bySite);
  let counter = 0;

  const directSiteKeys = (nodes: SkeletonNode[], into: string[]): void => {
    for (const node of nodes) {
      if (node.kind === "site") into.push(node.site.key);
      else if (node.kind === "group") directSiteKeys(node.children, into);
      // A nested loop owns its own sites.
    }
  };

  const visit = (nodes: SkeletonNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "loop") {
        const loopId = `loop${counter++}`;
        const keys: string[] = [];
        directSiteKeys(node.children, keys);
        const instances = keys
          .flatMap((key) => bySite.get(key) ?? [])
          .sort((left, right) => left.callIndex - right.callIndex);
        const iterations: NodeModel[][] = [];
        let current: NodeModel[] = [];
        let seen = new Set<string>();
        for (const instance of instances) {
          const key = innermostKey(instance.path ?? "");
          if (seen.has(key)) {
            iterations.push(current);
            current = [];
            seen = new Set();
          }
          seen.add(key);
          current.push(instance);
        }
        if (current.length > 0) iterations.push(current);

        const total = iterations.length;
        const selection = loopSelections.get(loopId);
        const shown =
          total === 0 ? 0 : Math.min(Math.max(selection ?? total - 1, 0), total - 1);
        loopMeta.set(loopId, { iterations: total, shown });

        const shownSet = new Set(iterations[shown]?.map((instance) => instance.callIndex) ?? []);
        for (const key of keys) {
          visibleInstances.set(
            key,
            (bySite.get(key) ?? []).filter((instance) => shownSet.has(instance.callIndex)),
          );
        }
        visit(node.children);
      } else if (node.kind === "group") {
        visit(node.children);
      }
    }
  };
  visit(skeleton.roots);
  return { loopMeta, visibleInstances };
}

export function layoutSkeletonGraph(
  skeleton: Skeleton,
  model: RunModel,
  expanded: ReadonlySet<string>,
  loopSelections: ReadonlyMap<string, number>,
): SkelLayout {
  const bySite = new Map<string, NodeModel[]>();
  const unmatched: NodeModel[] = [];
  for (const node of [...model.nodes.values()].sort((a, b) => a.callIndex - b.callIndex)) {
    const key =
      node.path !== undefined && (node.scope === undefined || node.scope === model.runId)
        ? innermostKey(node.path)
        : undefined;
    if (key !== undefined && skeleton.byKey.has(key)) {
      const list = bySite.get(key);
      if (list === undefined) bySite.set(key, [node]);
      else list.push(node);
    } else {
      unmatched.push(node);
    }
  }

  const { loopMeta, visibleInstances } = computeLoopData(skeleton, bySite, loopSelections);

  let loopCounter = 0;
  let phaseCounter = 0;
  const context: LayoutContext = {
    model,
    visibleInstances,
    allInstances: bySite,
    expanded,
    loopMeta,
    nextLoopId: () => `loop${loopCounter++}`,
    nextPhaseId: () => `ph${phaseCounter++}`,
  };

  const boxes: Box[] = [];
  for (const node of skeleton.roots) {
    const box = layoutNode(node, context);
    if (box !== undefined && box.placed.length > 0) boxes.push(box);
  }

  // Instances that did not attach to a site cluster at the end of the flow: agents of
  // nested workflow() runs (foreign scope — a different script, so no site can match)
  // grouped per child run, then own-scope strays (path capture failed, aliased calls).
  const clusters = new Map<string, { label: string; nodes: NodeModel[] }>();
  for (const node of unmatched) {
    const foreign = node.scope !== undefined && node.scope !== model.runId;
    const clusterKey = foreign ? `nested:${node.scope}` : "unmatched";
    const label = foreign
      ? `▸ nested ${node.scope?.split("-nested").at(-1) ?? ""}`.trim()
      : "unmapped";
    const cluster = clusters.get(clusterKey);
    if (cluster === undefined) clusters.set(clusterKey, { label, nodes: [node] });
    else cluster.nodes.push(node);
  }
  for (const [clusterKey, cluster] of clusters) {
    const box = emptyBox();
    let y = 0;
    const visible = expanded.has(clusterKey)
      ? cluster.nodes
      : cluster.nodes.slice(0, MAX_VISIBLE_STACK);
    for (const node of visible) {
      box.placed.push(instanceNode(node, 0, y));
      y += NODE_H + V_GAP;
    }
    const hidden = cluster.nodes.length - visible.length;
    if (hidden > 0) {
      box.placed.push({
        id: `m-${clusterKey}`,
        kind: "more",
        x: 0,
        y,
        w: NODE_W,
        h: NODE_H,
        label: `+${hidden} more`,
        sub: "agents",
        status: "pending",
        siteKey: clusterKey,
      });
      y += NODE_H + V_GAP;
    }
    box.w = NODE_W;
    box.h = y - V_GAP;
    box.brackets.push({
      x: -18,
      yTop: -6,
      yBottom: box.h + 6,
      label: `${cluster.label} · ${cluster.nodes.length}`,
    });
    boxes.push(box);
  }

  const root = connectSequence(boxes);
  shift(root, PADDING, PADDING);
  return {
    width: Math.max(root.w + PADDING * 2, 360),
    height: Math.max(root.h + PADDING * 2, 320),
    placed: root.placed,
    loops: root.loops,
    brackets: root.brackets,
    edges: root.edges,
    unmatchedCount: unmatched.length,
  };
}
