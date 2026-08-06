/**
 * The REPL workspaces' client-presence ledger — the daemon-side half of
 * the roadmap doc's client-presence drain policy: "Child ACP processes
 * stay warm while any MCP client is connected to the project (the
 * daemon's session registry already measures liveness by connection
 * presence). On last-client disconnect, in-flight subagent turns drain
 * to completion — their results settle into the VM and each settlement
 * boundary snapshots — and then idle children close. On the next client
 * connect, the workspace is live (or restores from snapshot) and
 * `followUp` re-attaches the subagent session lazily."
 *
 * One ledger per daemon. `touch(state, clientId)` marks an MCP session
 * as present on a project's workspace (every `repl` tool call from that
 * session touches); `disconnect(clientId)` runs when the session's last
 * connection closed (the daemon's session registry signals it — see
 * `SessionRegistry.onLastConnectionClosed`) or the session was deleted.
 * A project whose client set becomes EMPTY has its workspace drained:
 * the scheduled `drainReplProject` runs the broker's
 * `drainForDisconnect` — in-flight turns drain to completion (each
 * settlement boundary snapshots), then every idle child closes
 * (`keepSession` keeps the backend sessions re-openable). The concrete
 * drain bound is the daemon's session-eviction TTL (the spec-owed
 * decision: the bound REUSES the daemon's existing TTL knob rather than
 * inventing a new one — in-flight turns already run under the runner's
 * own runaway protections; the TTL is the outer ceiling). The workspace
 * and broker stay alive; the next client's followUp/steer/cancel
 * lazily re-attaches the recorded backend sessions (the broker's
 * capability-gated lazy re-attach), and a client reconnecting mid-drain
 * self-heals the same way (the drain's release may have closed the
 * children already — documented).
 *
 * Drains are single-flight per project (a second disconnect while a
 * drain runs is a no-op), and the ledger keeps the project's client set
 * accurate throughout — `touch` during a drain leaves the set non-empty
 * for the next disconnect to re-evaluate.
 */

import type { ReplProjectState } from "./repl-project.js";
import { drainReplProject, disconnectReplProject, touchReplProject } from "./repl-project.js";

/** One MCP session's presence on the projects' repl workspaces. */
export class ReplPresenceLedger {
  /** sessionId → the repl states that session has touched. */
  private readonly bySession = new Map<string, Set<ReplProjectState>>();
  /** repl state → the sessions currently present on it. */
  private readonly byProject = new Map<ReplProjectState, Set<string>>();
  /** repl states with a drain scheduled or running (single-flight). */
  private readonly draining = new Set<ReplProjectState>();

  constructor(private readonly boundMs: number) {}

  /** The concrete drain bound (the daemon's session-eviction TTL). */
  drainBoundMs(): number {
    return this.boundMs;
  }

  /**
   * Mark an MCP session as present on a project's repl workspace (every
   * `repl` tool call from that session touches). Idempotent per
   * (session, project).
   */
  touch(state: ReplProjectState, clientId: string): void {
    let sessions = this.byProject.get(state);
    if (sessions === undefined) {
      sessions = new Set();
      this.byProject.set(state, sessions);
    }
    sessions.add(clientId);
    touchReplProject(state, clientId);
    let projects = this.bySession.get(clientId);
    if (projects === undefined) {
      projects = new Set();
      this.bySession.set(clientId, projects);
    }
    projects.add(state);
  }

  /**
   * Run when an MCP session's last connection closed (or the session was
   * deleted): remove its presence from every project it touched; a
   * project whose client set became EMPTY is drained (single-flight).
   */
  disconnect(clientId: string): void {
    const projects = this.bySession.get(clientId);
    this.bySession.delete(clientId);
    if (projects === undefined) return;
    for (const state of projects) {
      const sessions = this.byProject.get(state);
      if (sessions !== undefined) {
        sessions.delete(clientId);
        if (sessions.size === 0) this.byProject.delete(state);
      }
      disconnectReplProject(state, clientId);
      if (state.clients.size === 0) this.scheduleDrain(state);
    }
  }

  /** Every project currently drained or draining (the status seam). */
  drainedProjects(): ReplProjectState[] {
    return [...this.draining];
  }

  /** Test seam: how many projects are mid-drain right now. */
  drainingCount(): number {
    return this.draining.size;
  }

  /** Drop every session's presence (daemon shutdown): the scheduled
   *  drains see the projects' client sets emptied and run to completion
   *  on the already-disposed brokers — a no-op there, cleared here. */
  disconnectAll(): void {
    for (const clientId of [...this.bySession.keys()]) this.disconnect(clientId);
  }

  private scheduleDrain(state: ReplProjectState): void {
    if (this.draining.has(state)) return;
    this.draining.add(state);
    void drainReplProject(state, this.boundMs)
      .catch(() => undefined)
      .finally(() => {
        this.draining.delete(state);
      });
  }
}
