import { Readable, Writable } from "node:stream";
import {
  agent as acpAgent,
  methods,
  ndJsonStream,
  type Stream,
} from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "./agent.js";
import { resolveDeps, type PiAcpDeps } from "./deps.js";
import { SESSION_STEERING_METHOD, steeringRequestParser } from "./steering.js";
import { LOADED_TURN_QUERY_METHOD, loadedTurnQueryParser } from "./loaded-turn.js";

export { PiAcpAgent } from "./agent.js";

export interface RunAcpOptions {
  deps?: Partial<PiAcpDeps>;
  stream?: Stream;
}

export async function runAcp(options: RunAcpOptions = {}) {
  const impl = new PiAcpAgent(await resolveDeps(options.deps));
  const app = acpAgent({ name: "@automatalabs/pi-acp" })
    .onRequest(methods.agent.initialize, (context) => impl.initialize(context))
    .onRequest(methods.agent.authenticate, (context) => impl.authenticate(context))
    .onRequest(methods.agent.session.new, (context) => impl.newSession(context))
    .onRequest(methods.agent.session.load, (context) => impl.loadSession(context))
    .onRequest(methods.agent.session.resume, (context) => impl.resumeSession(context))
    .onRequest(methods.agent.session.fork, (context) => impl.forkSession(context))
    .onRequest(methods.agent.session.list, (context) => impl.listSessions(context))
    .onRequest(methods.agent.session.close, (context) => impl.closeSession(context))
    .onRequest(methods.agent.session.setConfigOption, (context) => impl.setConfigOption(context))
    .onRequest(methods.agent.session.prompt, (context) => impl.prompt(context))
    .onRequest(SESSION_STEERING_METHOD, steeringRequestParser, (context) => impl.steer(context))
    .onRequest(LOADED_TURN_QUERY_METHOD, loadedTurnQueryParser, (context) => impl.loadedTurnQuery(context))
    .onNotification(methods.agent.session.cancel, (context) => impl.cancel(context));
  const stream = options.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  return { connection, agent: impl };
}
