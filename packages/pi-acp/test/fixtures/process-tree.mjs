#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [leaderPath, descendantPath] = process.argv.slice(2);
if (!leaderPath || !descendantPath) throw new Error("expected leader and descendant pid paths");

writeFileSync(leaderPath, String(process.pid));
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 180_000)"], {
  stdio: "ignore",
  windowsHide: true,
});
if (!descendant.pid) throw new Error("descendant spawned without pid");
writeFileSync(descendantPath, String(descendant.pid));

await new Promise((resolve, reject) => {
  descendant.once("error", reject);
  descendant.once("close", resolve);
});
