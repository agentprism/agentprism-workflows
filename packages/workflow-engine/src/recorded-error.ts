import type { WorkflowRecordedError } from "@automatalabs/shared-types";
import { WorkflowError } from "@automatalabs/shared-types";
import { cloneStrictJsonValue, deepFreeze, type StrictJsonValue } from "./strict-json.js";

function guardedRead(object: object, key: PropertyKey): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: Reflect.get(object, key) };
  } catch {
    return { ok: false };
  }
}

function projectOptional(
  output: Record<string, unknown>,
  source: object,
  key: string,
  markLossy: () => void,
): void {
  const read = guardedRead(source, key);
  if (!read.ok) {
    markLossy();
    return;
  }
  if (read.value === undefined) return;
  const projected = cloneStrictJsonValue(read.value);
  if (!projected.ok) {
    markLossy();
    return;
  }
  output[key] = projected.clone;
}

/** Project any thrown value without allowing projection failures to mask it. */
export function projectRecordedError(error: unknown): WorkflowRecordedError {
  try {
    let lossy = false;
    const markLossy = () => {
      lossy = true;
    };

    if (error instanceof WorkflowError) {
      const output: Record<string, unknown> = { form: "workflow-error" };
      const message = guardedRead(error, "message");
      if (message.ok && typeof message.value === "string") output.message = message.value;
      else markLossy();
      const code = guardedRead(error, "code");
      if (code.ok && typeof code.value === "string") output.code = code.value;
      else markLossy();
      const recoverable = guardedRead(error, "recoverable");
      if (recoverable.ok && typeof recoverable.value === "boolean") output.recoverable = recoverable.value;
      else markLossy();
      for (const key of [
        "agentLabel",
        "details",
        "resetHint",
        "providerUsageLimitContext",
        "authContext",
        "checkpointContext",
      ]) {
        projectOptional(output, error, key, markLossy);
      }
      if (lossy) output.lossy = true;
      return deepFreeze(output as unknown as WorkflowRecordedError);
    }

    if (error instanceof Error) {
      const output: Record<string, unknown> = { form: "error" };
      for (const key of ["name", "message"] as const) {
        const read = guardedRead(error, key);
        if (read.ok && typeof read.value === "string") output[key] = read.value;
        else markLossy();
      }

      const props: Record<string, StrictJsonValue> = {};
      let names: string[] = [];
      try {
        if (Object.getOwnPropertySymbols(error).length !== 0) markLossy();
        names = Object.getOwnPropertyNames(error);
      } catch {
        markLossy();
      }
      for (const key of names) {
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(error, key);
        } catch {
          markLossy();
          continue;
        }
        if (!descriptor?.enumerable) continue;
        if (!("value" in descriptor)) {
          markLossy();
          continue;
        }
        const projected = cloneStrictJsonValue(descriptor.value);
        if (!projected.ok) {
          markLossy();
          continue;
        }
        Object.defineProperty(props, key, {
          value: projected.clone,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      if (Object.keys(props).length !== 0) output.props = props;
      if (lossy) output.lossy = true;
      return deepFreeze(output as unknown as WorkflowRecordedError);
    }

    const projected = cloneStrictJsonValue(error);
    const output: WorkflowRecordedError = projected.ok
      ? { form: "value", value: projected.clone }
      : { form: "value", lossy: true };
    return deepFreeze(output);
  } catch {
    return deepFreeze({
      form: "error",
      name: "Error",
      message: "[unprojectable thrown value]",
      lossy: true,
    });
  }
}
