import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { WorkflowManager } from "@automatalabs/workflows";

const CONTROL_DIR = ".control";
const RUN_ID = /^[a-z0-9]+-[a-z0-9]+$/;
const OPERATION_ID = /^[0-9a-f-]{36}$/i;

export interface WholeStopIntent {
  version: 1;
  operationId: string;
  runId: string;
  action: "stop";
  requestedAt: string;
  requestedByInstanceId: string;
}

export interface WholeStopAcknowledgement {
  version: 1;
  operationId: string;
  runId: string;
  acknowledgedAt: string;
  acknowledgedByInstanceId: string;
  outcome: "stopped" | "already-terminal";
}

function root(manager: WorkflowManager): string {
  return join(manager.getPersistence().getRunsDir(), CONTROL_DIR);
}

function runDir(manager: WorkflowManager, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`Invalid run-control runId: ${runId}`);
  return join(root(manager), runId);
}

function requestPath(manager: WorkflowManager, runId: string, operationId: string): string {
  if (!OPERATION_ID.test(operationId)) throw new Error(`Invalid run-control operationId: ${operationId}`);
  return join(runDir(manager, runId), `${operationId}.request.json`);
}

function acknowledgementPath(manager: WorkflowManager, runId: string, operationId: string): string {
  if (!OPERATION_ID.test(operationId)) throw new Error(`Invalid run-control operationId: ${operationId}`);
  return join(runDir(manager, runId), `${operationId}.ack.json`);
}

function ensureRunDir(manager: WorkflowManager, runId: string): void {
  const dir = runDir(manager, runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(root(manager), 0o700);
  chmodSync(dir, 0o700);
}

function writeImmutableJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    // link is an atomic create-without-replace publication. Unlike rename on POSIX, it cannot
    // silently overwrite an acknowledgement another daemon already published.
    linkSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function validIntent(value: WholeStopIntent | undefined, runId?: string): value is WholeStopIntent {
  return value?.version === 1 &&
    value.action === "stop" &&
    OPERATION_ID.test(value.operationId) &&
    RUN_ID.test(value.runId) &&
    (runId === undefined || value.runId === runId) &&
    typeof value.requestedAt === "string" &&
    typeof value.requestedByInstanceId === "string";
}

function validAcknowledgement(
  value: WholeStopAcknowledgement | undefined,
  runId: string,
  operationId: string,
): value is WholeStopAcknowledgement {
  return value?.version === 1 &&
    value.runId === runId &&
    value.operationId === operationId &&
    typeof value.acknowledgedAt === "string" &&
    typeof value.acknowledgedByInstanceId === "string" &&
    (value.outcome === "stopped" || value.outcome === "already-terminal");
}

export function findPendingWholeStopIntent(
  manager: WorkflowManager,
  runId: string,
): WholeStopIntent | undefined {
  let files: string[];
  try {
    files = readdirSync(runDir(manager, runId)).filter((file) => file.endsWith(".request.json")).sort();
  } catch {
    return undefined;
  }
  for (const file of files) {
    const operationId = file.slice(0, -".request.json".length);
    if (!OPERATION_ID.test(operationId)) continue;
    const intent = readJson<WholeStopIntent>(requestPath(manager, runId, operationId));
    if (!validIntent(intent, runId)) continue;
    const acknowledgement = readWholeStopAcknowledgement(manager, runId, operationId);
    if (acknowledgement === undefined) return intent;
  }
  return undefined;
}

export function createOrReuseWholeStopIntent(
  manager: WorkflowManager,
  runId: string,
  requesterInstanceId: string,
): WholeStopIntent {
  const pending = findPendingWholeStopIntent(manager, runId);
  if (pending) return pending;
  ensureRunDir(manager, runId);
  for (;;) {
    const intent: WholeStopIntent = {
      version: 1,
      operationId: randomUUID(),
      runId,
      action: "stop",
      requestedAt: new Date().toISOString(),
      requestedByInstanceId: requesterInstanceId,
    };
    try {
      writeImmutableJson(requestPath(manager, runId, intent.operationId), intent);
      return intent;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function readWholeStopIntent(
  manager: WorkflowManager,
  runId: string,
  operationId: string,
): WholeStopIntent | undefined {
  const value = readJson<WholeStopIntent>(requestPath(manager, runId, operationId));
  return validIntent(value, runId) && value.operationId === operationId ? value : undefined;
}

export function readWholeStopAcknowledgement(
  manager: WorkflowManager,
  runId: string,
  operationId: string,
): WholeStopAcknowledgement | undefined {
  const value = readJson<WholeStopAcknowledgement>(acknowledgementPath(manager, runId, operationId));
  return validAcknowledgement(value, runId, operationId) ? value : undefined;
}

export function acknowledgeWholeStopIntent(
  manager: WorkflowManager,
  intent: WholeStopIntent,
  ownerInstanceId: string,
  outcome: WholeStopAcknowledgement["outcome"],
): WholeStopAcknowledgement {
  ensureRunDir(manager, intent.runId);
  const acknowledgement: WholeStopAcknowledgement = {
    version: 1,
    operationId: intent.operationId,
    runId: intent.runId,
    acknowledgedAt: new Date().toISOString(),
    acknowledgedByInstanceId: ownerInstanceId,
    outcome,
  };
  const path = acknowledgementPath(manager, intent.runId, intent.operationId);
  try {
    writeImmutableJson(path, acknowledgement);
    return acknowledgement;
  } catch (error) {
    const existing = readWholeStopAcknowledgement(manager, intent.runId, intent.operationId);
    if (existing) return existing;
    throw error;
  }
}

export function listPendingWholeStopIntents(manager: WorkflowManager): WholeStopIntent[] {
  let runIds: string[];
  try {
    runIds = readdirSync(root(manager)).filter((entry) => RUN_ID.test(entry));
  } catch {
    return [];
  }
  const intents: WholeStopIntent[] = [];
  for (const runId of runIds) {
    const pending = findPendingWholeStopIntent(manager, runId);
    if (pending) intents.push(pending);
  }
  return intents;
}

export function deleteRunControlSidecars(manager: WorkflowManager, runId: string): void {
  try {
    rmSync(runDir(manager, runId), { recursive: true, force: true });
  } catch {
    // Run deletion remains successful if best-effort sidecar cleanup fails.
  }
}
