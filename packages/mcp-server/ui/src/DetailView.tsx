// Detail view: the per-node log drill-in (mockup 2). Agent nodes show their durable
// transcript (or coarse progress rows when no transcript exists); phase nodes show the run
// log() lines emitted while that phase was current. Tool-call rows with a paired result
// expand on click into a constrained output block. Back returns to the graph.
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { fmtClock, fmtCost, fmtDuration, fmtTokens } from "./format.js";
import type { NodeSelection } from "./GraphView.js";
import { nodeRows } from "./state.js";
import type { DetailRow, NodeModel, RunModel } from "./state.js";

function StatusChip({ status }: { status: NodeModel["status"] | RunModel["status"] }) {
  switch (status) {
    case "done":
    case "completed":
      return <span className="chip chip-ok">✓ Completed</span>;
    case "error":
    case "failed":
      return <span className="chip chip-err">✗ Failed</span>;
    case "aborted":
      return <span className="chip chip-err">■ Stopped</span>;
    case "paused":
      return <span className="chip chip-warn">⏸ Paused</span>;
    default:
      return (
        <span className="chip chip-live">
          <span className="pulse" />
          Running
        </span>
      );
  }
}

/** How an agent is named in headers, per the mockups: model spec, else backend, else label. */
function agentDescriptor(node: NodeModel): string {
  return node.model ?? node.backendId ?? node.label;
}

function phaseHeading(model: RunModel, title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const index = model.phases.indexOf(title);
  return index >= 0 ? `Phase ${index + 1}: ${title}` : title;
}

function LogRow({
  row,
  expanded,
  onToggle,
}: {
  row: DetailRow;
  expanded: boolean;
  onToggle: (() => void) | undefined;
}) {
  const meta = row.meta !== undefined && row.meta !== row.text ? row.meta : "";
  const text = row.text || (row.meta !== undefined ? `ran ${row.meta}` : "");
  const expandable = onToggle !== undefined;
  return (
    <>
      <div
        className={`log-row kind-${row.kind}${row.isError === true ? " row-error" : ""}${expandable ? " expandable" : ""}`}
        onClick={onToggle}
      >
        <span className="row-ts">{row.ts !== undefined ? fmtClock(row.ts) : ""}</span>
        <span className="row-accent" />
        <div className="row-text">
          {expandable && <span className="row-chevron">{expanded ? "▾" : "▸"}</span>}
          {text}
        </div>
        <span className="row-meta">{meta}</span>
      </div>
      {expandable && expanded && row.detail !== undefined && (
        <div className={`row-detail${row.detail.isError === true ? " detail-error" : ""}`}>
          {row.detail.text}
        </div>
      )}
    </>
  );
}

function FinalRow({ node }: { node: NodeModel }) {
  if (node.status === "done") {
    const parts = [
      node.startTs !== undefined && node.endTs !== undefined
        ? fmtDuration(node.endTs - node.startTs)
        : "",
      node.costUsd !== undefined ? fmtCost(node.costUsd) : "",
    ].filter(Boolean);
    return (
      <div className="log-row row-final kind-done">
        <span className="row-ts">{node.endTs !== undefined ? fmtClock(node.endTs) : ""}</span>
        <span className="row-accent" />
        <div className="row-text">✓ completed</div>
        <span className="row-meta">{parts.join("  ")}</span>
      </div>
    );
  }
  if (node.status === "error") {
    return (
      <div className="log-row row-final kind-error">
        <span className="row-ts">{node.endTs !== undefined ? fmtClock(node.endTs) : ""}</span>
        <span className="row-accent" />
        <div className="row-text">
          ✗ {node.errorCode ?? "error"}
          {node.errorText ? ` — ${node.errorText}` : ""}
        </div>
        <span className="row-meta" />
      </div>
    );
  }
  return null;
}

function phaseLogRows(model: RunModel, phaseIndex: number): DetailRow[] {
  const title = model.phases[phaseIndex];
  const rows: DetailRow[] = [];
  model.phaseMarks.forEach((mark, markPosition) => {
    if (mark.title !== title) return;
    const next = model.phaseMarks[markPosition + 1];
    for (const row of model.logs) {
      if (row.order > mark.seq && (next === undefined || row.order < next.seq)) rows.push(row);
    }
  });
  return rows;
}

export function DetailView({
  model,
  target,
  onBack,
}: {
  model: RunModel;
  target: NodeSelection;
  onBack: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<number>>(new Set());

  // Keep the log pinned to the newest row while the viewer hasn't scrolled away.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight;
  });

  const node = target.kind === "agent" ? model.nodes.get(target.callIndex) : undefined;

  let title: string;
  let subtitle: string;
  let chip: ReactNode = null;
  let right = "";
  let rows: DetailRow[] = [];
  let finalRow: ReactNode = null;
  let empty: string | null = null;

  if (target.kind === "agent") {
    if (!node) {
      return <div className="log-empty">Agent call {target.callIndex} is no longer known.</div>;
    }
    // Mockup format: "Phase 2: Setup - opus[1m]".
    const heading = phaseHeading(model, node.phase);
    title = heading ?? agentDescriptor(node);
    subtitle = heading !== undefined ? `- ${agentDescriptor(node)}` : "";
    chip = <StatusChip status={node.status} />;
    right = [
      node.startTs !== undefined ? fmtDuration((node.endTs ?? Date.now()) - node.startTs) : "",
      node.tokens !== undefined ? `${fmtTokens(node.tokens)} tok` : "",
    ]
      .filter(Boolean)
      .join("  ");
    rows = nodeRows(node);
    finalRow = <FinalRow node={node} />;
    if (rows.length === 0 && node.status === "running") empty = "Waiting for activity…";
    if (rows.length === 0 && node.status !== "running" && finalRow === null) empty = "No log entries.";
  } else {
    // Mockup format: "Phase 2: Setup · Agents: opus[1m], codex".
    const phaseTitle = model.phases[target.phaseIndex];
    title = phaseHeading(model, phaseTitle) ?? "phase";
    const agents = [...model.nodes.values()]
      .filter((candidate) => candidate.phase === phaseTitle)
      .sort((left, right2) => left.startSeq - right2.startSeq)
      .map(agentDescriptor);
    subtitle = agents.length > 0 ? `· Agents: ${agents.join(", ")}` : "";
    rows = phaseLogRows(model, target.phaseIndex);
    if (rows.length === 0) empty = "No log() lines in this phase.";
  }

  return (
    <div className="detail">
      <div className="detail-header">
        <button className="back-btn" onClick={onBack} title="Back to graph">
          ‹
        </button>
        <span className="detail-title">{title}</span>
        <span className="detail-sub">{subtitle}</span>
        <span className="spacer" />
        {chip}
        <span className="detail-right">{right}</span>
      </div>
      <div
        className="log-rows"
        ref={listRef}
        onScroll={() => {
          const list = listRef.current;
          if (list) pinnedRef.current = list.scrollTop + list.clientHeight >= list.scrollHeight - 12;
        }}
      >
        {rows.map((row) => (
          <LogRow
            key={`${row.order}:${row.kind}`}
            row={row}
            expanded={expandedRows.has(row.order)}
            onToggle={
              row.detail !== undefined
                ? () =>
                    setExpandedRows((current) => {
                      const next = new Set(current);
                      if (next.has(row.order)) next.delete(row.order);
                      else next.add(row.order);
                      return next;
                    })
                : undefined
            }
          />
        ))}
        {finalRow}
        {empty !== null && <div className="log-empty">{empty}</div>}
      </div>
    </div>
  );
}
