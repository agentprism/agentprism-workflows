import type { AgentRunner } from "@automatalabs/shared-types";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** The maximum time reserved for graceful ACP process teardown before exit is forced. */
export const SHUTDOWN_DEADLINE_MS = 5_000;

export type McpServerShutdownReason = "stdin-close" | "stdin-end" | "transport-close" | "SIGINT" | "SIGTERM";

/** A small server-owned admission gate, kept separate from the MCP transport lifecycle. */
export interface WorkflowServerControl {
  stopAcceptingWork(): void;
}

interface DisposableRunner {
  dispose(): Promise<void>;
}

interface ShutdownProcess {
  stdin: {
    once(event: "close" | "end", listener: () => void): unknown;
    removeListener(event: "close" | "end", listener: () => void): unknown;
  };
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code?: number): unknown;
}

export interface McpServerLifecycleOptions {
  runner: AgentRunner;
  server: WorkflowServerControl;
  transport: Transport;
  process?: ShutdownProcess;
  deadlineMs?: number;
}

export interface McpServerLifecycle {
  shutdown(reason: McpServerShutdownReason): Promise<void>;
  isShuttingDown(): boolean;
}

function isDisposableRunner(runner: AgentRunner): runner is AgentRunner & DisposableRunner {
  return "dispose" in runner && typeof runner.dispose === "function";
}

function exitCodeFor(reason: McpServerShutdownReason): number {
  // `process.exit()` replaces Node's default signal termination, so retain the conventional
  // shell statuses for SIGINT (128 + 2) and SIGTERM (128 + 15). Client disconnect is clean.
  if (reason === "SIGINT") return 130;
  if (reason === "SIGTERM") return 143;
  return 0;
}

/**
 * Own the stdio server's process lifetime. The first termination trigger closes the workflow
 * admission gate, disposes the concrete ACP runner (and therefore every pooled backend process),
 * then exits. Disposal errors are intentionally contained: process exit remains guaranteed.
 */
export function installMcpServerLifecycle(options: McpServerLifecycleOptions): McpServerLifecycle {
  const processHandle = options.process ?? process;
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  let shutdownPromise: Promise<void> | undefined;
  let shuttingDown = false;

  const onStdinClose = () => {
    void lifecycle.shutdown("stdin-close");
  };
  const onStdinEnd = () => {
    void lifecycle.shutdown("stdin-end");
  };
  const onSigint = () => {
    void lifecycle.shutdown("SIGINT");
  };
  const onSigterm = () => {
    void lifecycle.shutdown("SIGTERM");
  };
  const previousTransportOnClose = options.transport.onclose;
  const onTransportClose = () => {
    try {
      previousTransportOnClose?.();
    } catch {
      // The shutdown path cannot allow a third-party close hook to prevent cleanup.
    }
    void lifecycle.shutdown("transport-close");
  };

  const removeListeners = () => {
    processHandle.stdin.removeListener("close", onStdinClose);
    processHandle.stdin.removeListener("end", onStdinEnd);
    processHandle.removeListener("SIGINT", onSigint);
    processHandle.removeListener("SIGTERM", onSigterm);
  };

  const lifecycle: McpServerLifecycle = {
    shutdown(reason) {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      options.server.stopAcceptingWork();

      const runner = options.runner;
      const dispose = isDisposableRunner(runner)
        ? Promise.resolve().then(() => runner.dispose()).catch(() => undefined)
        : Promise.resolve();
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        deadlineTimer = setTimeout(resolve, deadlineMs);
      });

      shutdownPromise = Promise.race([dispose, deadline]).then(() => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        removeListeners();
        processHandle.exit(exitCodeFor(reason));
      });
      return shutdownPromise;
    },
    isShuttingDown() {
      return shuttingDown;
    },
  };

  options.transport.onclose = onTransportClose;
  processHandle.stdin.once("close", onStdinClose);
  processHandle.stdin.once("end", onStdinEnd);
  processHandle.once("SIGINT", onSigint);
  processHandle.once("SIGTERM", onSigterm);
  return lifecycle;
}
