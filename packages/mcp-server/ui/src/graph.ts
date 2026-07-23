// Graph layout: left-to-right timeline of phase markers and agent waves. Wave membership is
// inferred from real concurrency (a node joins the wave while it overlaps every member's
// active interval), so parallel() fan-outs stack vertically with a bracket and sequential
// chains advance one column at a time. Pure geometry — rendering lives in GraphView.tsx.
import type { NodeModel, RunModel } from "./state.js";

export const NODE_W = 200;
export const NODE_H = 64;
export const PHASE_W = 184;
const H_GAP = 92;
const V_GAP = 36;
const PADDING = 44;
const MAX_VISIBLE_WAVE = 8;

export interface GraphColumn {
  kind: "phase" | "wave";
  phase?: string;
  /** Stable key for expansion state: `${segmentIndex}:${waveIndex}`. */
  waveKey?: string;
  nodes: NodeModel[];
  hiddenCount: number;
}

export interface PlacedNode {
  column: GraphColumn;
  node?: NodeModel;
  kind: "phase" | "agent" | "more";
  label: string;
  sub: string;
  x: number;
  y: number;
  w: number;
  h: number;
  status?: NodeModel["status"];
  callIndex?: number;
  phaseIndex?: number;
  waveKey?: string;
}

export interface GraphLayout {
  width: number;
  height: number;
  placed: PlacedNode[];
  edges: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  parallelBrackets: Array<{ x: number; yTop: number; yBottom: number; label: string }>;
}

function activeEnd(node: NodeModel): number {
  return node.status === "running" ? Number.POSITIVE_INFINITY : (node.endTs ?? node.startTs ?? 0);
}

export function buildColumns(model: RunModel, expandedWaves: ReadonlySet<string>): GraphColumn[] {
  const nodes = [...model.nodes.values()].sort((a, b) => a.startSeq - b.startSeq);
  const columns: GraphColumn[] = [];
  const phaseSeen = new Map<string, number>();

  let segmentPhase: string | undefined;
  let segmentIndex = -1;
  let waveIndex = 0;
  let wave: NodeModel[] | undefined;
  let waveMinEnd = Number.POSITIVE_INFINITY;

  const pushWave = () => {
    if (!wave || wave.length === 0) return;
    const waveKey = `${segmentIndex}:${waveIndex}`;
    const expanded = expandedWaves.has(waveKey);
    const visible = expanded ? wave : wave.slice(0, MAX_VISIBLE_WAVE);
    columns.push({
      kind: "wave",
      waveKey,
      nodes: visible,
      hiddenCount: wave.length - visible.length,
      ...(segmentPhase !== undefined ? { phase: segmentPhase } : {}),
    });
    waveIndex += 1;
    wave = undefined;
    waveMinEnd = Number.POSITIVE_INFINITY;
  };

  for (const node of nodes) {
    if (segmentIndex === -1 || node.phase !== segmentPhase) {
      pushWave();
      segmentIndex += 1;
      waveIndex = 0;
      segmentPhase = node.phase;
      if (node.phase !== undefined && !phaseSeen.has(node.phase)) {
        phaseSeen.set(node.phase, model.phases.indexOf(node.phase));
        columns.push({ kind: "phase", phase: node.phase, nodes: [], hiddenCount: 0 });
      }
    }
    const start = node.startTs ?? 0;
    if (wave && start < waveMinEnd) {
      wave.push(node);
      waveMinEnd = Math.min(waveMinEnd, activeEnd(node));
    } else {
      pushWave();
      wave = [node];
      waveMinEnd = activeEnd(node);
    }
  }
  pushWave();

  // A phase announced but with no agents yet (fresh run or between fan-outs) still shows.
  const lastPhase = model.phases.at(-1);
  if (lastPhase !== undefined && !phaseSeen.has(lastPhase)) {
    columns.push({ kind: "phase", phase: lastPhase, nodes: [], hiddenCount: 0 });
  }
  return columns;
}

export function layoutGraph(model: RunModel, expandedWaves: ReadonlySet<string>): GraphLayout {
  const columns = buildColumns(model, expandedWaves);
  const placed: PlacedNode[] = [];
  const columnMembers: PlacedNode[][] = [];

  let maxStack = 1;
  for (const column of columns) {
    const count = column.kind === "phase" ? 1 : column.nodes.length + (column.hiddenCount > 0 ? 1 : 0);
    maxStack = Math.max(maxStack, count);
  }
  const height = Math.max(320, maxStack * NODE_H + (maxStack - 1) * V_GAP + PADDING * 2);

  let x = PADDING;
  for (const column of columns) {
    const members: PlacedNode[] = [];
    if (column.kind === "phase") {
      const y = (height - NODE_H) / 2;
      members.push({
        column,
        kind: "phase",
        label: column.phase ?? "",
        sub: "phase",
        x,
        y,
        w: PHASE_W,
        h: NODE_H,
        phaseIndex: Math.max(0, model.phases.indexOf(column.phase ?? "")),
      });
      x += PHASE_W + H_GAP;
    } else {
      const count = column.nodes.length + (column.hiddenCount > 0 ? 1 : 0);
      const stackH = count * NODE_H + (count - 1) * V_GAP;
      let y = (height - stackH) / 2;
      for (const node of column.nodes) {
        members.push({
          column,
          node,
          kind: "agent",
          label: node.label,
          sub: node.model ?? node.backendId ?? "agent",
          x,
          y,
          w: NODE_W,
          h: NODE_H,
          status: node.status,
          callIndex: node.callIndex,
        });
        y += NODE_H + V_GAP;
      }
      if (column.hiddenCount > 0) {
        members.push({
          column,
          kind: "more",
          label: `+${column.hiddenCount} more`,
          sub: "agents",
          x,
          y,
          w: NODE_W,
          h: NODE_H,
          ...(column.waveKey !== undefined ? { waveKey: column.waveKey } : {}),
        });
      }
      x += NODE_W + H_GAP;
    }
    placed.push(...members);
    columnMembers.push(members);
  }

  const edges: GraphLayout["edges"] = [];
  for (let i = 0; i + 1 < columnMembers.length; i++) {
    for (const from of columnMembers[i] ?? []) {
      for (const to of columnMembers[i + 1] ?? []) {
        edges.push({
          x1: from.x + from.w,
          y1: from.y + from.h / 2,
          x2: to.x,
          y2: to.y + to.h / 2,
        });
      }
    }
  }

  const parallelBrackets: GraphLayout["parallelBrackets"] = [];
  for (const members of columnMembers) {
    const agents = members.filter((member) => member.kind !== "phase");
    const first = agents[0];
    const last = agents.at(-1);
    if (!first || !last || agents.length < 2) continue;
    const total = first.column.nodes.length + first.column.hiddenCount;
    parallelBrackets.push({
      x: first.x - 18,
      yTop: first.y - 6,
      yBottom: last.y + last.h + 6,
      label: `${total} parallel`,
    });
  }

  return { width: Math.max(x - H_GAP + PADDING, 360), height, placed, edges, parallelBrackets };
}

export function edgePath(edge: GraphLayout["edges"][number]): string {
  const dx = Math.max(36, (edge.x2 - edge.x1) / 2);
  return `M ${edge.x1} ${edge.y1} C ${edge.x1 + dx} ${edge.y1}, ${edge.x2 - dx} ${edge.y2}, ${edge.x2} ${edge.y2}`;
}

export function bracketPath(bracket: GraphLayout["parallelBrackets"][number]): string {
  return `M ${bracket.x + 8} ${bracket.yTop} H ${bracket.x} V ${bracket.yBottom} H ${bracket.x + 8}`;
}
