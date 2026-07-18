import { Buffer } from "node:buffer";
import { WorkflowManager } from "../../src/workflow-manager.js";

const [cwd, persistenceRoot, runId, encodedScript] = process.argv.slice(2);
if (!cwd || !persistenceRoot || !runId || !encodedScript) {
  throw new Error("stale-lock-child requires cwd, persistenceRoot, runId, and script");
}

const script = Buffer.from(encodedScript, "base64url").toString("utf8");
let calls = 0;
const manager = new WorkflowManager({
  cwd,
  persistenceRoot,
  environmentKey: "crash-environment",
  agent: {
    async run(prompt: string) {
      calls++;
      if (calls === 1) return `child:${prompt}`;
      process.stdout.write("SECOND_AGENT_STARTED\n");
      setInterval(() => {}, 1_000);
      return await new Promise<never>(() => {});
    },
  },
});

const started = manager.startInBackground(script, undefined, { runId });
await started.promise;
