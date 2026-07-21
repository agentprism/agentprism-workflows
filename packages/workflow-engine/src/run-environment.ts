import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

export type RunEnvironmentIdentity = {
  git?: { head: string; dirtyDigest: string };
  key?: string;
};

function fieldRemainder(record: Buffer, fields: number): Buffer | undefined {
  let spaces = 0;
  for (let index = 0; index < record.length; index++) {
    if (record[index] !== 0x20) continue;
    spaces++;
    if (spaces === fields) return record.subarray(index + 1);
  }
  return undefined;
}

function listedPaths(status: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= status.length; index++) {
    if (index === status.length || status[index] === 0) {
      records.push(status.subarray(start, index));
      start = index + 1;
    }
  }
  const paths: Buffer[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length === 0) continue;
    if (record[0] === 0x3f && record[1] === 0x20) {
      paths.push(record.subarray(2));
      continue;
    }
    if (record[0] === 0x31 && record[1] === 0x20) {
      const path = fieldRemainder(record, 8);
      if (path) paths.push(path);
      continue;
    }
    if (record[0] === 0x32 && record[1] === 0x20) {
      const path = fieldRemainder(record, 9);
      if (path) paths.push(path);
      index++;
      continue;
    }
    if (record[0] === 0x75 && record[1] === 0x20) {
      const path = fieldRemainder(record, 10);
      if (path) paths.push(path);
    }
  }
  const unique = new Map<string, Buffer>();
  for (const path of paths) unique.set(path.toString("hex"), path);
  return [...unique.values()];
}

function contentDigest(path: Buffer): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return createHash("sha256").update(readlinkSync(path, { encoding: "buffer" })).digest("hex");
    }
    if (stat.isFile()) return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    // A deletion has no current content; its status bytes still identify it.
  }
  return createHash("sha256").update("<missing>").digest("hex");
}

/** Capture bounded run-environment provenance without making execution fail.
 * This snapshot is diagnostic only and must never gate journal replay. */
export function captureRunEnvironment(
  effectiveCwd: string,
  environmentKey?: string,
): RunEnvironmentIdentity | undefined {
  try {
    const root = execFileSync("git", ["-C", effectiveCwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync(
      "git",
      ["-C", root, "status", "--porcelain=v2", "-z", "--untracked-files=all"],
      { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    );
    const digest = createHash("sha256").update(status);
    const rootPrefix = Buffer.from(root.endsWith("/") ? root : `${root}/`);
    for (const path of listedPaths(status)) {
      digest.update(contentDigest(Buffer.concat([rootPrefix, path])));
    }
    return { git: { head, dirtyDigest: digest.digest("hex") } };
  } catch {
    return environmentKey !== undefined ? { key: environmentKey } : undefined;
  }
}
