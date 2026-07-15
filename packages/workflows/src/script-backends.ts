import { WorkflowError, WorkflowErrorCode } from "@automatalabs/workflow-engine";
import type { WorkflowBackendConfig } from "@automatalabs/shared-types";

export type ScriptBackendApproval =
  | boolean
  | ((backend: { name: string } & WorkflowBackendConfig) => boolean | Promise<boolean>);

/** Resolve explicit host approval for script-declared command-spawning backends. */
export async function approveScriptBackends(
  declared: Record<string, WorkflowBackendConfig>,
  approval: ScriptBackendApproval | undefined,
  helperName: "runDynamicWorkflow" | "runIsolation",
): Promise<Record<string, WorkflowBackendConfig>> {
  const names = Object.keys(declared).join(", ");
  if (approval === undefined || approval === false) {
    const guidance =
      helperName === "runDynamicWorkflow"
        ? "Pass allowScriptBackends: true (or a per-backend approval callback) to runDynamicWorkflow, or thread an approved registry yourself via exec.scriptBackends."
        : "Pass allowScriptBackends: true (or a per-backend approval callback) to runIsolation.";
    throw new WorkflowError(
      `script declares custom ACP backends (meta.backends: ${names}) — these spawn commands on this machine and require explicit approval. ` +
        guidance,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  if (approval === true) return declared;
  for (const [name, config] of Object.entries(declared)) {
    if (!(await approval({ name, ...config }))) {
      throw new WorkflowError(
        `script backend "${name}" (command: ${config.command}) was declined by the allowScriptBackends callback — aborting the run`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
  }
  return declared;
}
