/**
 * `daemon <start|stop|status|url|run|logs>` — human-facing management of the workflow
 * daemon. These are plain CLI commands (stdout is for humans here, not JSON-RPC).
 */

import { readFileSync } from "node:fs";

import { SERVER_VERSION } from "../server.js";
import { ensureDaemonRunning, stopDaemon } from "../shim/ensure-daemon.js";
import { DAEMON_NAME } from "./constants.js";
import { clearDaemonInfo, daemonLogPath, pidIsAlive, probeHealthz, readDaemonInfo } from "./daemon-info.js";
import { resolveDaemonPort, runDaemon } from "./run-daemon.js";

export const DAEMON_USAGE = `Usage: daemon <command>

Commands:
  start            Start the daemon in the background (no-op when already running)
  stop             Stop the running daemon (SIGTERM, waits for exit)
  status           Show pid, port, version, uptime, sessions, and active runs
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
  ].join("\n");
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
      const info = readDaemonInfo();
      if (info === undefined || !pidIsAlive(info.pid)) {
        if (info !== undefined) clearDaemonInfo(info.pid);
        console.log(`${DAEMON_NAME} is not running`);
        return 0;
      }
      const stopped = await stopDaemon(info.pid, 7_000);
      if (!stopped) {
        console.error(`${DAEMON_NAME} (pid ${info.pid}) did not exit within 7s`);
        return 1;
      }
      console.log(`${DAEMON_NAME} (pid ${info.pid}) stopped`);
      return 0;
    }
    case "status": {
      const info = readDaemonInfo();
      const health = info !== undefined && pidIsAlive(info.pid) ? await probeHealthz(info.port) : undefined;
      if (info === undefined || health === undefined || health.pid !== info.pid) {
        console.log(`${DAEMON_NAME}: not running (client v${SERVER_VERSION}, default port ${resolveDaemonPort()})`);
        return 1;
      }
      const uptimeMs = Date.now() - Date.parse(health.startedAt);
      console.log(
        [
          `${DAEMON_NAME} v${health.version}`,
          `  pid:         ${health.pid}`,
          `  url:         ${info.url}`,
          `  uptime:      ${Math.round(uptimeMs / 1000)}s`,
          `  sessions:    ${health.sessions}`,
          `  active runs: ${health.activeRuns}`,
          ...(health.lameDuck
            ? ["  lame duck:   yes (superseded by a newer daemon — draining, admits no new sessions)"]
            : []),
          ...health.projects.map((p) => `    ${p.projectDir}: ${p.activeRuns} active run(s)`),
        ].join("\n"),
      );
      return 0;
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
