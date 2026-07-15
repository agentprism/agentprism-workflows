import { createAcpRunner } from "@automatalabs/acp-agents";
import {
  createReplayRunner,
  createRunPersistence,
  parseWorkflowScript,
  runIsolation as runEngineIsolation,
  WorkflowError,
  WorkflowErrorCode,
} from "@automatalabs/workflow-engine";
import type {
  CheckpointCallContext,
  IsolationRunResult,
  IsolationTarget,
  ReplayCallReport,
  ReplayDivergenceEvent,
  ReplayObservation,
  ReplayReport,
  ReplayRunner,
  ReplayRunnerOptions,
  ResolvedIsolationTarget,
  RunIsolationOptions,
} from "@automatalabs/workflow-engine";
import type {
  AgentRunner,
  WorkflowCallRecord,
  WorkflowRecordedError,
} from "@automatalabs/shared-types";
import { approveScriptBackends, type ScriptBackendApproval } from "./script-backends.js";

type OwnedRunner = AgentRunner & { dispose: () => Promise<void> };
type DefaultRunnerFactory = () => OwnedRunner;

let defaultRunnerFactory: DefaultRunnerFactory = createAcpRunner;

/** Test-only injection point for the owned default runner. Deliberately absent from the package barrel. */
export function __setDefaultRunnerFactoryForTests(factory: DefaultRunnerFactory | undefined): void {
  defaultRunnerFactory = factory ?? createAcpRunner;
}

export interface RunIsolationSdkOptions
  extends Omit<RunIsolationOptions, "runner" | "scriptBackends"> {
  /** Omitted => createAcpRunner(), disposed after the run. */
  runner?: AgentRunner;
  /** Approval policy for the recording script's declared meta.backends. */
  allowScriptBackends?: ScriptBackendApproval;
}

/**
 * Execute an isolation run with the SDK's ACP-defaulted runner and script-backend
 * approval policy. Caller-supplied runners remain caller-owned.
 */
export async function runIsolation<T = unknown>(
  opts: RunIsolationSdkOptions,
): Promise<IsolationRunResult<T>> {
  let recording: ReturnType<ReturnType<typeof createRunPersistence>["load"]>;
  try {
    const persistence = createRunPersistence(opts.cwd ?? process.cwd(), undefined, {
      persistenceRoot: opts.persistenceRoot,
    });
    recording = persistence.load(opts.baselineRunId);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(
      error instanceof Error ? error.message : String(error),
      WorkflowErrorCode.PERSISTENCE_ERROR,
      { recoverable: false },
    );
  }

  let declared: RunIsolationOptions["scriptBackends"];
  if (recording && typeof recording.script === "string") {
    try {
      declared = parseWorkflowScript(recording.script).meta.backends;
    } catch {
      // The engine owns malformed-recording diagnosis and will reject it with its
      // typed preflight error after reloading the same persisted bytes.
    }
  }
  const scriptBackends =
    declared && Object.keys(declared).length > 0
      ? await approveScriptBackends(declared, opts.allowScriptBackends, "runIsolation")
      : undefined;

  const owned = opts.runner === undefined;
  const runner = opts.runner ?? defaultRunnerFactory();
  try {
    const { allowScriptBackends: _approval, ...engineOptions } = opts;
    return await runEngineIsolation<T>({
      ...engineOptions,
      runner,
      ...(scriptBackends === undefined ? {} : { scriptBackends }),
    });
  } finally {
    if (owned) await (runner as OwnedRunner).dispose();
  }
}

export { createReplayRunner };
export type {
  CheckpointCallContext,
  IsolationRunResult,
  IsolationTarget,
  ReplayCallReport,
  ReplayDivergenceEvent,
  ReplayObservation,
  ReplayReport,
  ReplayRunner,
  ReplayRunnerOptions,
  ResolvedIsolationTarget,
  RunIsolationOptions,
  WorkflowCallRecord,
  WorkflowRecordedError,
};
