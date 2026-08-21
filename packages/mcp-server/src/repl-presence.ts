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
 * capability-gated lazy re-attach), and a client reconnecting MID-drain
 * ABORTS the drain — the broker consults the project's client set every
 * iteration and before every destructive phase, so the children stay
 * warm while any client is connected (phase-D review round 6: the drain
 * used to run to its release phase and close every child regardless of
 * presence).
 *
 * **Disconnect retains the session's project AFFINITY** (which projects
 * the session touched), so a reconnect of the SAME live session — a
 * transient standalone-GET drop, then the client reconnects without a
 * new MCP session — restores its presence from `reconnect(clientId)`
 * WITHOUT requiring a new tool call (phase-E review rejection: the
 * session registry wired only disconnects, so a transient drop left the
 * session's presence gone — the already-scheduled drain could close
 * children while that client was connected). Only a session DELETION
 * (`forget`) drops the affinity: a deleted session can never reconnect,
 * and a re-initialized client carries a new session id.
 *
 * A drain that FAILS — a snapshot-flush failure mid-drain, for example
 * — is never discarded silently (phase-D review round 6): the failure
 * is recorded on the project state (`drainError`), surfaced loudly in
 * every repl tool result, and the drain latch stays clear so the next
 * disconnect retries the drain (the store's writer retains the failed
 * boundary's dirty flag for that retry).
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
  /** sessionId → the repl states that session has touched (RETAINED
   *  across disconnects — the session's project affinity; dropped only
   *  by `forget` when the session is deleted, see the module docs). */
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
   * The session's project AFFINITY is retained (see the module docs) so
   * a reconnect of the same live session can restore its presence; the
   * drain decision reads the ledger's own per-project set (the
   * authoritative presence — the same set `touch`/`reconnect` maintain),
   * never a snapshot of the projects' `clients` sets.
   */
  disconnect(clientId: string): void {
    const projects = this.bySession.get(clientId);
    if (projects === undefined) return;
    for (const state of projects) {
      const sessions = this.byProject.get(state);
      let last = false;
      if (sessions !== undefined) {
        sessions.delete(clientId);
        if (sessions.size === 0) {
          this.byProject.delete(state);
          last = true;
        }
      }
      disconnectReplProject(state, clientId);
      if (last) this.scheduleDrain(state);
    }
  }

  /**
   * Run when a connection OPENS on a live session (the daemon's session
   * registry signals it — a reconnect of the SAME session after a
   * transient drop): restore the session's presence on every project it
   * retains affinity with (see the module docs). A project whose drain
   * was already scheduled or is mid-flight sees the re-added client and
   * skips/aborts it — children stay warm while any client is connected.
   */
  reconnect(clientId: string): void {
    const projects = this.bySession.get(clientId);
    if (projects === undefined) return;
    for (const state of projects) {
      this.touch(state, clientId);
    }
  }

  /**
   * Run when a session record is deleted (DELETE, transport close,
   * eviction): drop the session's retained project affinity. The
   * session can never reconnect; a re-initialized client carries a new
   * session id and re-touches projects through its tool calls. (The
   * registry fires `disconnect` BEFORE this — the presence removal and
   * drain evaluation walk the affinity.)
   */
  forget(clientId: string): void {
    this.bySession.delete(clientId);
  }

  /** Every project currently drained or draining (the status seam). */
  drainedProjects(): ReplProjectState[] {
    return [...this.draining];
  }

  /** Test seam: how many projects are mid-drain right now. */
  drainingCount(): number {
    return this.draining.size;
  }

  /**
   * True when any workspace the session has affinity with has a subagent turn running. The
   * lame-duck migration keeps such sessions: closing one would drain the workspace here while
   * the migrated client re-opens it on the successor — a workspace split across two daemons.
   */
  sessionHasBusyWorkspace(clientId: string): boolean {
    const projects = this.bySession.get(clientId);
    if (projects === undefined) return false;
    for (const state of projects) {
      if (state.broker !== null && state.broker.busySessionCount() > 0) return true;
    }
    return false;
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
      .catch(() => {
        // The drain runs detached — there is no caller to propagate to.
        // The failure is NOT silent: `drainReplProject` recorded it on
        // the project state (`drainError`), every repl tool result
        // surfaces it loudly, and the drain latch stayed clear so the
        // next disconnect retries (phase-D review round 6: the failure
        // used to vanish here).
      })
      .finally(() => {
        this.draining.delete(state);
      });
  }
}
