/**
 * `daemon <start|stop|status|url|run|logs>` — human-facing management of the workflow
 * daemon. These are plain CLI commands (stdout is for humans here, not JSON-RPC).
 */

import { readFileSync } from "node:fs";

import { SERVER_VERSION } from "../server.js";
import { ensureDaemonRunning, stopDaemon } from "../shim/ensure-daemon.js";
import { DAEMON_NAME } from "./constants.js";
import {
  clearDaemonInfo,
  daemonLogPath,
  envFingerprint,
  listDaemonInstances,
  pidIsAlive,
  probeHealthz,
  readDaemonInfo,
  type DaemonHealth,
  type DaemonInstance,
} from "./daemon-info.js";
import { resolveDaemonPort, runDaemon } from "./run-daemon.js";

export const DAEMON_USAGE = `Usage: daemon <command>

Commands:
  start            Start the daemon in the background (no-op when already running)
  stop [--all]     Stop this env's daemon (SIGTERM, waits for exit); --all stops every daemon
                   on this machine, including draining (superseded) and legacy ones
  status           Show every daemon: pid, port, version, uptime, sessions, active runs
  url              Print the MCP endpoint URL and client registration snippets
  run              Run the daemon in the foreground (logs to stderr)
  logs [-n LINES]  Print the tail of the daemon log
`;

export function formatUrlSnippets(url: string): string {
  return [
    `MCP endpoint: ${url}`,
    "",
    "Claude Code:",
    `  claude mcp add --transport http agentprism-workflows ${url}`,
    "",
    "Codex (~/.codex/config.toml):",
    "  [mcp_servers.agentprism-workflows]",
    `  url = "${url}"`,
    "",
    "One registration serves every project: each workflow run names its project via the",
    "required `projectDir` tool argument (inspect/await/stop locate a runId automatically).",
    "Stdio clients need no registration changes: the default stdio command proxies to this daemon automatically.",
    "Note: a direct HTTP registration pins this daemon's port; after a version upgrade the current",
    "daemon may listen elsewhere — re-run `daemon url`. The stdio command follows upgrades automatically.",
  ].join("\n");
}

interface ProbedInstance extends DaemonInstance {
  health: DaemonHealth | undefined;
}

async function probeAll(): Promise<ProbedInstance[]> {
  const instances = listDaemonInstances();
  return Promise.all(
    instances.map(async (instance) => {
      const health = await probeHealthz(instance.info.port);
      return { ...instance, health: health !== undefined && health.pid === instance.info.pid ? health : undefined };
    }),
  );
}

function formatInstance(instance: ProbedInstance, currentPid: number | undefined): string[] {
  const { info, health } = instance;
  const role = instance.legacy
    ? "legacy (pre-family daemon; stop it with `daemon stop --all`)"
    : info.pid === currentPid
      ? "current for this env"
      : health?.lameDuck
        ? "draining (superseded by a newer daemon; admits no new sessions)"
        : "other env family";
  const lines = [
    `${DAEMON_NAME} v${health?.version ?? info.version}`,
    `  pid:         ${info.pid}`,
    `  url:         ${info.url}`,
    `  role:        ${role}`,
    `  instance:    ${health?.instanceId ?? info.instanceId ?? "legacy/unknown"}`,
    `  run control: ${health?.controlProtocol === 1 || info.controlProtocol === 1 ? "v1" : "unavailable"}`,
  ];
  if (health === undefined) {
    lines.push("  health:      not responding (pid alive, /healthz unreachable)");
    return lines;
  }
  const uptimeMs = Date.now() - Date.parse(health.startedAt);
  lines.push(
    `  uptime:      ${Math.round(uptimeMs / 1000)}s`,
    `  sessions:    ${health.sessions}`,
    `  active runs: ${health.activeRuns}`,
    ...(health.inflightRequests !== undefined ? [`  in flight:   ${health.inflightRequests} request(s)`] : []),
    ...health.projects.map((p) => `    ${p.projectDir}: ${p.activeRuns} active run(s)`),
  );
  return lines;
}

async function stopInstance(instance: DaemonInstance, timeoutMs: number): Promise<boolean> {
  const stopped = await stopDaemon(instance.info.pid, timeoutMs);
  if (stopped) {
    // A graceful exit clears its own records; a legacy daemon's file is left for it (pid-checked).
    if (!instance.legacy) clearDaemonInfo(instance.info.pid);
    console.log(`${DAEMON_NAME} (pid ${instance.info.pid}, v${instance.info.version}) stopped`);
  } else {
    console.error(`${DAEMON_NAME} (pid ${instance.info.pid}) did not exit within ${Math.round(timeoutMs / 1000)}s`);
  }
  return stopped;
}

export async function runDaemonCommand(args: string[], options: { bundlePath: string }): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "run": {
      const portFlag = rest.indexOf("--port");
      const port = portFlag >= 0 ? Number.parseInt(rest[portFlag + 1] ?? "", 10) : undefined;
      const outcome = await runDaemon({ port: port !== undefined && Number.isFinite(port) ? port : undefined });
      if (outcome === "already-running") return 0;
      // The listening server holds the process open; the lifecycle exits the process.
      await new Promise(() => undefined);
      return 0;
    }
    case "start": {
      const info = await ensureDaemonRunning({ bundlePath: options.bundlePath, log: (line) => console.error(line) });
      console.log(`${DAEMON_NAME} v${info.version} running (pid ${info.pid}) at ${info.url}`);
      return 0;
    }
    case "stop": {
      if (rest.includes("--all")) {
        const instances = listDaemonInstances();
        if (instances.length === 0) {
          console.log(`${DAEMON_NAME} is not running`);
          return 0;
        }
        const results = await Promise.all(instances.map((instance) => stopInstance(instance, 7_000)));
        return results.every(Boolean) ? 0 : 1;
      }
      const info = readDaemonInfo();
      if (info === undefined || !pidIsAlive(info.pid)) {
        if (info !== undefined) clearDaemonInfo(info.pid);
        const others = listDaemonInstances();
        console.log(
          `${DAEMON_NAME} is not running for this env` +
            (others.length > 0 ? ` (${others.length} other daemon(s) alive — see \`daemon status\`, stop with \`daemon stop --all\`)` : ""),
        );
        return 0;
      }
      const stopped = await stopInstance({ info, legacy: false }, 7_000);
      return stopped ? 0 : 1;
    }
    case "status": {
      const current = readDaemonInfo();
      const currentPid = current !== undefined && pidIsAlive(current.pid) ? current.pid : undefined;
      const instances = await probeAll();
      if (instances.length === 0) {
        console.log(
          `${DAEMON_NAME}: not running (client v${SERVER_VERSION}, env family ${envFingerprint()}, default port ${resolveDaemonPort()})`,
        );
        return 1;
      }
      const blocks = instances
        .sort((a, b) => (a.info.pid === currentPid ? -1 : b.info.pid === currentPid ? 1 : 0))
        .map((instance) => formatInstance(instance, currentPid).join("\n"));
      console.log(blocks.join("\n\n"));
      if (currentPid === undefined) {
        console.log(`\n(no current daemon for this env — client v${SERVER_VERSION}, env family ${envFingerprint()})`);
      }
      return currentPid === undefined ? 1 : 0;
    }
    case "url": {
      const info = readDaemonInfo();
      const running = info !== undefined && pidIsAlive(info.pid);
      const url = running ? info.url : `http://127.0.0.1:${resolveDaemonPort()}/mcp`;
      if (!running) {
        console.error(`${DAEMON_NAME} is not currently running; showing the default endpoint. Start it with 'daemon start'.`);
      }
      console.log(formatUrlSnippets(url));
      return 0;
    }
    case "logs": {
      const flagIndex = rest.indexOf("-n");
      const lines = flagIndex >= 0 ? Number.parseInt(rest[flagIndex + 1] ?? "", 10) : 100;
      const count = Number.isFinite(lines) && lines > 0 ? lines : 100;
      let content: string;
      try {
        content = readFileSync(daemonLogPath(), "utf-8");
      } catch {
        console.log(`no daemon log at ${daemonLogPath()}`);
        return 0;
      }
      const all = content.split("\n");
      console.log(all.slice(Math.max(0, all.length - count - 1)).join("\n"));
      return 0;
    }
    default: {
      console.error(DAEMON_USAGE);
      return command === undefined || command === "--help" || command === "help" ? 0 : 1;
    }
  }
}
