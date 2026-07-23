// Graph view: renders the layout computed in graph.ts as positioned nodes over an SVG edge
// layer. React keeps the DOM stable across poll re-renders, so canvas scroll position and
// hover states survive updates for free.
import { bracketPath, edgePath, layoutGraph } from "./graph.js";
import type { PlacedNode } from "./graph.js";
import type { RunModel } from "./state.js";

export type NodeSelection =
  | { kind: "agent"; callIndex: number }
  | { kind: "phase"; phaseIndex: number };

function placedKey(item: PlacedNode): string {
  if (item.kind === "agent") return `a${item.callIndex}`;
  if (item.kind === "more") return `m${item.waveKey}`;
  return `p${item.phaseIndex}:${item.label}`;
}

export function GraphView({
  model,
  expandedWaves,
  onExpandWave,
  onSelect,
}: {
  model: RunModel;
  expandedWaves: ReadonlySet<string>;
  onExpandWave: (waveKey: string) => void;
  onSelect: (selection: NodeSelection) => void;
}) {
  const layout = layoutGraph(model, expandedWaves);

  const handleClick = (item: PlacedNode) => {
    if (item.kind === "more") {
      if (item.waveKey !== undefined) onExpandWave(item.waveKey);
    } else if (item.kind === "phase") {
      onSelect({ kind: "phase", phaseIndex: item.phaseIndex ?? 0 });
    } else if (item.callIndex !== undefined) {
      onSelect({ kind: "agent", callIndex: item.callIndex });
    }
  };

  return (
    <div className="canvas-wrap">
      <div className="graph-inner" style={{ width: layout.width, height: layout.height }}>
        <svg
          className="graph-edges"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
        >
          {layout.edges.map((edge, index) => (
            <path key={index} className="edge" d={edgePath(edge)} />
          ))}
          {layout.parallelBrackets.map((bracket, index) => (
            <path key={index} className="bracket" d={bracketPath(bracket)} />
          ))}
        </svg>
        <div className="graph-nodes">
          {layout.parallelBrackets.map((bracket, index) => (
            <div
              key={index}
              className="parallel-label"
              style={{ left: bracket.x - 4, top: bracket.yTop - 26 }}
            >
              {bracket.label}
            </div>
          ))}
          {layout.placed.map((item) => (
            <div
              key={placedKey(item)}
              className={
                item.kind === "phase"
                  ? "node phase-node"
                  : item.kind === "more"
                    ? "node more-node"
                    : `node status-${item.status ?? "running"}`
              }
              style={{ left: item.x, top: item.y, width: item.w, height: item.h }}
              onClick={() => handleClick(item)}
            >
              <div className="node-side" />
              <div className="node-body">
                <div className="node-label">{item.label}</div>
                <div className="node-sub">{item.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
