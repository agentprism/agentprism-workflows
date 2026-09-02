// Skeleton-driven graph layout: the script's static structure is drawn from t=0 with
// unexecuted sites muted, while runtime NodeModels attach by structural call path. Quality
// primitives are first-class containers: gates expose producer/reviewer lanes and feedback,
// loopUntilDry exposes rounds and its dry condition, and verify/judgePanel expose panel shape.
// Pure geometry — rendering lives in GraphView.tsx.
import { NODE_H, NODE_W, PHASE_W } from "./graph.js";
import { innermostKey } from "./skeleton.js";
import type {
  Skeleton,
  SkeletonLoopMode,
  SkeletonNode,
  SkeletonPanelMode,
  SkeletonSite,
} from "./skeleton.js";
import type { NodeModel, NodeStatus, RunModel } from "./state.js";

const H_GAP = 92;
const V_GAP = 36;
const PADDING = 44;
const CONTAINER_PAD = 26;
const CONTAINER_HEAD = 48;
const STAGE_GAP = 56;
const FEEDBACK_SPACE = 34;
const MAX_VISIBLE_STACK = 6;
const MAX_STATIC_INSTANCES = 100;

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
  mode: SkeletonLoopMode;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  detail: string;
  iterations: number;
  /** 0-based index of the iteration currently displayed. */
  shown: number;
}

export interface SkelPanelBox {
  panelId: string;
  mode: SkeletonPanelMode;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  detail: string;
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
  kind?: "flow" | "feedback";
  /** Feedback edges route beneath their enclosing gate. */
  bendY?: number;
}

export interface SkelLayout {
  width: number;
  height: number;
  placed: SkelPlacedNode[];
  loops: SkelLoopBox[];
  panels: SkelPanelBox[];
  brackets: SkelBracket[];
  edges: SkelEdge[];
  /** Instances that could not be attached to any site (no path, foreign scope, alias). */
  unmatchedCount: number;
}

/** Even a control-only script has a more truthful static view than a timing-inferred wave. */
export function skeletonIsUseful(skeleton: Skeleton): boolean {
  return skeleton.roots.length > 0;
}

interface Box {
  w: number;
  h: number;
  placed: SkelPlacedNode[];
  loops: SkelLoopBox[];
  panels: SkelPanelBox[];
  brackets: SkelBracket[];
  edges: SkelEdge[];
}

function emptyBox(): Box {
  return { w: 0, h: 0, placed: [], loops: [], panels: [], brackets: [], edges: [] };
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
  for (const panel of box.panels) {
    panel.x += dx;
    panel.y += dy;
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
    if (edge.bendY !== undefined) edge.bendY += dy;
  }
}

function merge(into: Box, from: Box): void {
  into.placed.push(...from.placed);
  into.loops.push(...from.loops);
  into.panels.push(...from.panels);
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
  nextPanelId: () => string;
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

function siteLabel(site: SkeletonSite): string {
  return site.labelPreview ?? site.promptPreview ?? `${site.helper ?? site.kind}()`;
}

function pendingSub(site: SkeletonSite, index: number, total: number): string {
  const kind = site.kind === "agent" ? "agent" : (site.helper ?? site.kind);
  return total > 1 ? `${kind} · ${index + 1}/${total} pending` : `${kind} · pending`;
}

function layoutSite(site: SkeletonSite, context: LayoutContext, staticInvocations = 1): Box {
  const box = emptyBox();
  if (site.kind === "checkpoint") return layoutCheckpointSite(site, context);

  const instances = context.visibleInstances.get(site.key) ?? [];
  const rawExpected = Math.max((site.expectedInstances ?? 1) * staticInvocations, 1);
  const total = Math.max(instances.length, rawExpected);
  const expanded = context.expanded.has(site.key);
  const visibleCount = Math.min(
    total,
    expanded ? MAX_STATIC_INSTANCES : MAX_VISIBLE_STACK,
  );
  let y = 0;

  for (let index = 0; index < visibleCount; index += 1) {
    const instance = instances[index];
    if (instance !== undefined) {
      box.placed.push(instanceNode(instance, 0, y));
    } else {
      box.placed.push({
        id: `s${site.key}:${index}`,
        kind: "site",
        x: 0,
        y,
        w: NODE_W,
        h: NODE_H,
        label: siteLabel(site),
        sub: pendingSub(site, index, rawExpected),
        status: "pending",
        siteKey: site.key,
      });
    }
    y += NODE_H + V_GAP;
  }

  const hidden = total - visibleCount;
  if (hidden > 0) {
    box.placed.push({
      id: `m${site.key}`,
      kind: "more",
      x: 0,
      y,
      w: NODE_W,
      h: NODE_H,
      label: `+${hidden} more`,
      sub: instances.length < rawExpected ? `${rawExpected} planned` : "agents",
      status: "pending",
      siteKey: site.key,
    });
    y += NODE_H + V_GAP;
  }
  box.w = NODE_W;
  box.h = Math.max(NODE_H, y - V_GAP);
  return box;
}

/**
 * Checkpoints emit no agentStart; their settlement callRecords carry the path. The site
 * stays muted until at least one decision lands, then shows the latest outcome.
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
      id: `s${site.key}:0`,
      kind: "site",
      x: 0,
      y: 0,
      w: NODE_W,
      h: NODE_H,
      label,
      sub: "checkpoint · pending",
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
  if (node.kind === "group" || node.kind === "loop" || node.kind === "panel") {
    return node.children.reduce((sum, child) => sum + groupObservedCount(child, context), 0);
  }
  return 0;
}

function layoutNode(
  node: SkeletonNode,
  context: LayoutContext,
  staticInvocations = 1,
): Box | undefined {
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
        sub: "phase boundary",
        status: reached ? "done" : "pending",
        ...(phaseIndex !== undefined && phaseIndex >= 0 ? { phaseIndex } : {}),
      });
      box.w = PHASE_W;
      box.h = NODE_H;
      return box;
    }
    case "site":
      return layoutSite(node.site, context, staticInvocations);
    case "group": {
      const inner =
        node.mode === "pipeline" && node.stages !== undefined && node.stages.length > 0
          ? layoutRow(
              node.stages.map((stage) =>
                layoutColumn(stage, context, stage.length === 1 ? node.staticCount : undefined),
              ),
              STAGE_GAP,
            )
          : layoutColumn(
              node.children,
              context,
              node.children.length === 1 ? node.staticCount : undefined,
            );
      if (inner.placed.length === 0) return undefined;
      const observed = groupObservedCount(node, context);
      const count = node.staticCount ?? (observed > 0 ? observed : undefined);
      const label = `${node.mode}${count !== undefined ? ` ×${count}` : ""}`;
      inner.brackets.push({ x: -18, yTop: -6, yBottom: inner.h + 6, label });
      return inner;
    }
    case "panel":
      return layoutPanel(node, context, staticInvocations);
    case "loop":
      return layoutLoop(node, context, staticInvocations);
  }
}

function layoutPanel(
  node: Extract<SkeletonNode, { kind: "panel" }>,
  context: LayoutContext,
  staticInvocations: number,
): Box | undefined {
  const panelId = context.nextPanelId();
  const inner = layoutColumn(node.children, context, staticInvocations);
  if (inner.placed.length === 0) return undefined;
  const box = emptyBox();
  shift(inner, CONTAINER_PAD, CONTAINER_HEAD);
  merge(box, inner);
  box.w = inner.w + CONTAINER_PAD * 2;
  box.h = inner.h + CONTAINER_HEAD + CONTAINER_PAD;
  const label = node.mode === "verify" ? "VERIFY" : "JUDGE PANEL";
  const detail =
    node.mode === "verify"
      ? `${node.members} reviewer${node.members === 1 ? "" : "s"} · pass ≥ ${Math.round((node.threshold ?? 0.5) * 100)}%${node.lenses === undefined ? "" : ` · ${node.lenses} lenses`}`
      : node.candidates === undefined
        ? `${node.members} judge${node.members === 1 ? "" : "s"} per candidate`
        : `${node.candidates} candidate${node.candidates === 1 ? "" : "s"} × ${node.members} judges`;
  box.panels.push({ panelId, mode: node.mode, x: 0, y: 0, w: box.w, h: box.h, label, detail });
  return box;
}

function loopLabel(mode: SkeletonLoopMode): string {
  if (mode === "gate") return "GATE";
  if (mode === "loopUntilDry") return "LOOP UNTIL DRY";
  return "LOOP";
}

function loopDetail(
  node: Extract<SkeletonNode, { kind: "loop" }>,
  iterations: number,
  shown: number,
): string {
  if (node.mode === "gate") {
    const observed = iterations > 0 ? `attempt ${shown + 1} of ${iterations} observed` : "produce → validate";
    return `${observed} · ${node.maxIterations ?? 3} max`;
  }
  if (node.mode === "loopUntilDry") {
    const observed = iterations > 0 ? `round ${shown + 1}/${iterations} · ` : "";
    return `${observed}${node.consecutiveEmpty ?? 2} dry to stop · ${node.maxIterations ?? 50} rounds max`;
  }
  return iterations > 0 ? `iteration ${shown + 1} of ${iterations}` : "repeating block";
}

function layoutGateStages(
  stages: SkeletonNode[][],
  context: LayoutContext,
  staticInvocations: number,
): Box {
  const lanes = stages.map((stage) => layoutColumn(stage, context, staticInvocations));
  const inner = connectSequence(lanes);
  if (lanes.length >= 2 && inner.placed.length > 0) {
    const left = lanes[0];
    const right = lanes.at(-1);
    if (left !== undefined && right !== undefined) {
      inner.edges.push({
        x1: inner.w,
        y1: inner.h / 2,
        x2: 0,
        y2: inner.h / 2,
        kind: "feedback",
        bendY: inner.h + FEEDBACK_SPACE - 8,
      });
      inner.h += FEEDBACK_SPACE;
    }
  }
  return inner;
}

function layoutLoop(
  node: Extract<SkeletonNode, { kind: "loop" }>,
  context: LayoutContext,
  staticInvocations: number,
): Box | undefined {
  const loopId = context.nextLoopId();
  const inner =
    node.mode === "gate" && node.stages !== undefined
      ? layoutGateStages(node.stages, context, staticInvocations)
      : layoutColumnAsSequence(node.children, context, staticInvocations);
  if (inner.placed.length === 0) return undefined;
  const meta = context.loopMeta.get(loopId) ?? { iterations: 0, shown: 0 };
  const box = emptyBox();
  shift(inner, CONTAINER_PAD, CONTAINER_HEAD);
  merge(box, inner);
  box.w = inner.w + CONTAINER_PAD * 2;
  box.h = inner.h + CONTAINER_HEAD + CONTAINER_PAD;
  box.loops.push({
    loopId,
    mode: node.mode,
    x: 0,
    y: 0,
    w: box.w,
    h: box.h,
    label: loopLabel(node.mode),
    detail: loopDetail(node, meta.iterations, meta.shown),
    iterations: meta.iterations,
    shown: meta.shown,
  });
  return box;
}

/** Vertical stack (parallel members, one pipeline stage). */
function layoutColumn(
  nodes: SkeletonNode[],
  context: LayoutContext,
  staticInvocations = 1,
): Box {
  const box = emptyBox();
  let y = 0;
  let width = 0;
  for (const node of nodes) {
    const child = layoutNode(node, context, nodes.length === 1 ? staticInvocations : 1);
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
function layoutColumnAsSequence(
  nodes: SkeletonNode[],
  context: LayoutContext,
  staticInvocations = 1,
): Box {
  const boxes: Box[] = [];
  for (const node of nodes) {
    const child = layoutNode(node, context, nodes.length === 1 ? staticInvocations : 1);
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
    if (box.placed.length === 0) continue;
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
        kind: "flow",
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
 * partitions. A site belongs to its nearest enclosing loop; nested loops partition independently.
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
      else if (node.kind === "group" || node.kind === "panel") directSiteKeys(node.children, into);
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
        const shown = total === 0 ? 0 : Math.min(Math.max(selection ?? total - 1, 0), total - 1);
        loopMeta.set(loopId, { iterations: total, shown });

        const shownSet = new Set(iterations[shown]?.map((instance) => instance.callIndex) ?? []);
        for (const key of keys) {
          visibleInstances.set(
            key,
            (bySite.get(key) ?? []).filter((instance) => shownSet.has(instance.callIndex)),
          );
        }
        visit(node.children);
      } else if (node.kind === "group" || node.kind === "panel") {
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
  let panelCounter = 0;
  let phaseCounter = 0;
  const context: LayoutContext = {
    model,
    visibleInstances,
    allInstances: bySite,
    expanded,
    loopMeta,
    nextLoopId: () => `loop${loopCounter++}`,
    nextPanelId: () => `panel${panelCounter++}`,
    nextPhaseId: () => `ph${phaseCounter++}`,
  };

  const boxes: Box[] = [];
  for (const node of skeleton.roots) {
    const box = layoutNode(node, context);
    if (box !== undefined && box.placed.length > 0) boxes.push(box);
  }

  // Instances that did not attach to a site cluster at the end of the flow: agents of nested
  // workflow() runs grouped per child run, then own-scope strays (path capture failed, aliases).
  const clusters = new Map<string, { label: string; nodes: NodeModel[] }>();
  for (const node of unmatched) {
    const foreign = node.scope !== undefined && node.scope !== model.runId;
    const clusterKey = foreign ? `nested:${node.scope}` : "unmatched";
    const label = foreign
      ? `nested ${node.scope?.split("-nested").at(-1) ?? ""}`.trim()
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
    panels: root.panels,
    brackets: root.brackets,
    edges: root.edges,
    unmatchedCount: unmatched.length,
  };
}
