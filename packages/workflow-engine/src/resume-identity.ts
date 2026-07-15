import type { RunEnvironmentIdentity } from "./run-environment.js";

export type ResumeCallKind = "agent" | "checkpoint";
export type ResumeExactKey = `${ResumeCallKind}\u0000${string}\u0000${string}`;
export type ResumeContentKey = `${string}\u0000${string}`;

export function resumeExactKey(kind: ResumeCallKind, path: string, hash: string): ResumeExactKey {
  return `${kind}\u0000${path}\u0000${hash}`;
}

export function resumeContentKey(hash: string, inputsHash: string): ResumeContentKey {
  return `${hash}\u0000${inputsHash}`;
}

export function resumeOccurrenceKey(sourceRunId: string, recordedIndex: number): string {
  return `${sourceRunId}\u0000${recordedIndex}`;
}

export function appendIndexValue<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const values = index.get(key) ?? [];
  values.push(value);
  index.set(key, values);
}

export function buildResumeExactIndex<T>(
  values: Iterable<T>,
  identity: (value: T) => { kind: ResumeCallKind; path: string; hash: string },
): Map<ResumeExactKey, T[]> {
  const index = new Map<ResumeExactKey, T[]>();
  for (const value of values) {
    const facts = identity(value);
    appendIndexValue(index, resumeExactKey(facts.kind, facts.path, facts.hash), value);
  }
  return index;
}

export function isRunEnvironmentIdentity(value: unknown): value is RunEnvironmentIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const environment = value as Record<string, unknown>;
  const hasGit = environment.git !== undefined;
  const hasKey = environment.key !== undefined;
  if (hasGit === hasKey) return false;
  if (hasKey) return typeof environment.key === "string";
  if (typeof environment.git !== "object" || environment.git === null || Array.isArray(environment.git)) {
    return false;
  }
  const git = environment.git as Record<string, unknown>;
  return typeof git.head === "string" && typeof git.dirtyDigest === "string";
}

export function environmentsEqual(
  left: RunEnvironmentIdentity | undefined,
  right: RunEnvironmentIdentity | undefined,
): boolean {
  if (!isRunEnvironmentIdentity(left) || !isRunEnvironmentIdentity(right)) return false;
  if (left.git && right.git) {
    return left.git.head === right.git.head && left.git.dirtyDigest === right.git.dirtyDigest;
  }
  return left.key !== undefined && right.key !== undefined && left.key === right.key;
}
