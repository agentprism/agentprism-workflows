import type {
  AcpEventContext,
  AcpEventListener,
  AcpEventName,
  AcpRunnerEventMap,
  AgentRunner,
  RunOptions,
} from "../../src/index.js";
import { TypedEventEmitter, WorkflowManager } from "../../src/index.js";

const [cwd, persistenceRoot, runId, encodedScript] = process.argv.slice(2);
if (!cwd || !persistenceRoot || !runId || !encodedScript) {
  throw new Error("live-observability-crash-child requires cwd, persistenceRoot, runId, and script");
}

class CrashEventRunner {
  private readonly bus = new TypedEventEmitter<AcpRunnerEventMap>();

  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void {
    return this.bus.on(name, listener);
  }

  async run(_prompt: string, options?: RunOptions): Promise<unknown> {
    const context: AcpEventContext = {
      sessionId: "crashed-observe-session",
      backendId: "claude",
      label: options?.label,
      runId: options?.runId,
      callIndex: options?.callIndex,
    };
    this.bus.emit("session_open", context);
    const text = {
      sessionUpdate: "agent_message_chunk",
      messageId: "crashed-message",
      content: { type: "text", text: "durable content before crash" },
    } as AcpRunnerEventMap["session_update"]["update"];
    this.bus.emit("session_update", { ...context, update: text });
    return await new Promise<never>(() => {});
  }
}

const manager = new WorkflowManager({
  cwd,
  persistenceRoot,
  agent: new CrashEventRunner() as unknown as AgentRunner,
});
const script = Buffer.from(encodedScript, "base64url").toString("utf8");
const started = manager.startInBackground(script, undefined, { runId });
void started.promise.catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

for (let attempt = 0; attempt < 2_000; attempt++) {
  const events = manager.getPersistence().readEvents(runId, { limit: 100 }).events;
  if (events.some((record) => record.event.type === "agentProgress") &&
      events.some((record) => record.event.type === "agentTranscript")) {
    process.stdout.write("LIVE_OBSERVABILITY_READY\n");
    setInterval(() => {}, 1_000);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (attempt === 1_999) throw new Error("timed out waiting for child observability records");
}
