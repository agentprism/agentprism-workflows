// Graph view: renders the skeleton-driven layout when the run's script was fetched and
// parsed (sites muted until instances attach, loop containers with iteration selection),
// and falls back to the timing-based wave layout otherwise. React keeps the DOM stable
// across poll re-renders, so canvas scroll position and hover states survive updates.
import { bracketPath, edgePath, layoutGraph } from "./graph.js";
import type { PlacedNode } from "./graph.js";
import { layoutSkeletonGraph, skeletonIsUseful } from "./skeleton-graph.js";
import type { SkelEdge, SkelPlacedNode } from "./skeleton-graph.js";
import type { Skeleton } from "./skeleton.js";
import type { RunModel } from "./state.js";

export type NodeSelection =
  | { kind: "agent"; callIndex: number }
  | { kind: "phase"; phaseIndex: number };

function placedKey(item: PlacedNode): string {
  if (item.kind === "agent") return `a${item.callIndex}`;
  if (item.kind === "more") return `m${item.waveKey}`;
  return `p${item.phaseIndex}:${item.label}`;
}

function WaveGraph({
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

function skelNodeClass(item: SkelPlacedNode): string {
  if (item.kind === "phase") {
    return `node phase-node${item.status === "pending" ? " status-pending" : ""}`;
  }
  if (item.kind === "more") return "node more-node";
  return `node status-${item.status}`;
}

function skelEdgePath(edge: SkelEdge): string {
  if (edge.kind !== "feedback") return edgePath(edge);
  const bendY = edge.bendY ?? Math.max(edge.y1, edge.y2) + 28;
  return (
    `M ${edge.x1} ${edge.y1} ` +
    `C ${edge.x1 + 24} ${edge.y1}, ${edge.x1 + 24} ${bendY}, ${edge.x1} ${bendY} ` +
    `H ${edge.x2 - 24} ` +
    `C ${edge.x2 - 24} ${bendY}, ${edge.x2 - 24} ${edge.y2}, ${edge.x2} ${edge.y2}`
  );
}

function SkeletonGraph({
  model,
  skeleton,
  expandedWaves,
  onExpandWave,
  loopSelections,
  onSelectLoopIteration,
  onSelect,
}: {
  model: RunModel;
  skeleton: Skeleton;
  expandedWaves: ReadonlySet<string>;
  onExpandWave: (key: string) => void;
  loopSelections: ReadonlyMap<string, number>;
  onSelectLoopIteration: (loopId: string, iteration: number) => void;
  onSelect: (selection: NodeSelection) => void;
}) {
  const layout = layoutSkeletonGraph(skeleton, model, expandedWaves, loopSelections);

  const handleClick = (item: SkelPlacedNode) => {
    if (item.kind === "more") {
      if (item.siteKey !== undefined) onExpandWave(item.siteKey);
    } else if (item.kind === "phase") {
      if (item.phaseIndex !== undefined) onSelect({ kind: "phase", phaseIndex: item.phaseIndex });
    } else if (item.kind === "instance" && item.callIndex !== undefined) {
      onSelect({ kind: "agent", callIndex: item.callIndex });
    }
    // A muted site has nothing to inspect yet.
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
          <defs>
            <marker
              id="feedback-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
          </defs>
          {layout.edges.map((edge, index) => (
            <path
              key={index}
              className={`edge${edge.kind === "feedback" ? " edge-feedback" : ""}`}
              d={skelEdgePath(edge)}
              markerEnd={edge.kind === "feedback" ? "url(#feedback-arrow)" : undefined}
            />
          ))}
          {layout.brackets.map((bracket, index) => (
            <path key={index} className="bracket" d={bracketPath(bracket)} />
          ))}
        </svg>
        <div className="graph-controls">
          {[...layout.loops, ...layout.panels]
            .sort((left, right) => right.w * right.h - left.w * left.h)
            .map((control) => {
              const isLoop = "loopId" in control;
              return (
                <div
                  key={isLoop ? control.loopId : control.panelId}
                  className={`control-box control-${control.mode}`}
                  style={{ left: control.x, top: control.y, width: control.w, height: control.h }}
                >
                  <div className="control-head">
                    <span className="control-mark" aria-hidden="true" />
                    <span className="control-label">{control.label}</span>
                    <span className="control-detail">{control.detail}</span>
                    {isLoop && control.iterations > 1 && (
                      <span className="loop-iter">
                        <button
                          className="iter-btn"
                          aria-label="Previous iteration"
                          disabled={control.shown === 0}
                          onClick={() => onSelectLoopIteration(control.loopId, control.shown - 1)}
                        >
                          ‹
                        </button>
                        {control.mode === "gate" ? "attempt" : "iteration"} {control.shown + 1}/
                        {control.iterations}
                        <button
                          className="iter-btn"
                          aria-label="Next iteration"
                          disabled={control.shown >= control.iterations - 1}
                          onClick={() => onSelectLoopIteration(control.loopId, control.shown + 1)}
                        >
                          ›
                        </button>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
        <div className="graph-nodes">
          {layout.edges.map(
            (edge, index) =>
              edge.kind === "feedback" && (
                <div
                  key={`feedback-${index}`}
                  className="feedback-label"
                  style={{
                    left: Math.min(edge.x1, edge.x2) + Math.abs(edge.x1 - edge.x2) / 2 - 34,
                    top: (edge.bendY ?? Math.max(edge.y1, edge.y2) + 28) - 18,
                  }}
                >
                  feedback
                </div>
              ),
          )}
          {layout.brackets.map((bracket, index) => (
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
              key={item.id}
              className={skelNodeClass(item)}
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

export function GraphView({
  model,
  skeleton,
  expandedWaves,
  onExpandWave,
  loopSelections,
  onSelectLoopIteration,
  onSelect,
}: {
  model: RunModel;
  skeleton: Skeleton | undefined;
  expandedWaves: ReadonlySet<string>;
  onExpandWave: (waveKey: string) => void;
  loopSelections: ReadonlyMap<string, number>;
  onSelectLoopIteration: (loopId: string, iteration: number) => void;
  onSelect: (selection: NodeSelection) => void;
}) {
  if (skeleton !== undefined && skeletonIsUseful(skeleton)) {
    return (
      <SkeletonGraph
        model={model}
        skeleton={skeleton}
        expandedWaves={expandedWaves}
        onExpandWave={onExpandWave}
        loopSelections={loopSelections}
        onSelectLoopIteration={onSelectLoopIteration}
        onSelect={onSelect}
      />
    );
  }
  return (
    <WaveGraph
      model={model}
      expandedWaves={expandedWaves}
      onExpandWave={onExpandWave}
      onSelect={onSelect}
    />
  );
}
