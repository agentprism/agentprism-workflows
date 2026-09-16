// The in-process Streamable HTTP MCP host both client-hosted tool servers share: bound to
// 127.0.0.1 on an ephemeral port, lazily (the first registration binds), serving one MCP server
// per unguessable token path. A request that names no live token is a 404; a request on a live
// token gets a fresh stateless transport + MCP `Server` pair for its lifetime (the SDK's stateless
// pattern, so concurrent calls never share protocol state). Subclasses own the token → server
// mapping (`StructuredOutputToolHost`: one slot per registered schema; `AgentToolHost`: one token
// for the agent's function tools) and the tool handlers.
import http, {
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const LOCAL_MCP_HOST = "127.0.0.1";

/** How long `closeServer()` lets requests that were mid-answer finish writing before every
 *  remaining connection is torn down (a tool run that ignores its abort signal must not keep the
 *  agent's `close()` hanging). */
const CLOSE_DRAIN_GRACE_MS = 1000;

export abstract class LocalMcpHttpHost {
  private server: HttpServer | undefined;
  private listenPromise: Promise<void> | undefined;
  private port: number | undefined;
  private inFlightRequests = 0;
  private drained: (() => void) | undefined;

  /** A human name for error messages (`<name> MCP server did not bind …`). */
  protected abstract readonly hostName: string;

  /** The MCP server that answers requests on `token`, or undefined for a 404. Called once per
   *  HTTP request; the returned server is connected to a fresh transport and closed with it. */
  protected abstract mcpServerFor(token: string, req: IncomingMessage, res: ServerResponse): Server | undefined;

  isListening(): boolean {
    return this.server?.listening === true;
  }

  listeningPort(): number | undefined {
    return this.port;
  }

  /** Stop listening. Idempotent; resolves once the HTTP server closed (immediately when it never
   *  bound). A peer's keep-alive socket never holds the close open: idle connections are closed at
   *  once, requests still being answered get a bounded grace to flush, then everything left is
   *  destroyed — the peer is the agent process, which is gone or going. */
  protected async closeServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listenPromise = undefined;
    this.port = undefined;
    if (!server || !server.listening) return;
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeIdleConnections();
    if (this.inFlightRequests > 0) {
      await Promise.race([
        new Promise<void>((resolve) => (this.drained = resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, CLOSE_DRAIN_GRACE_MS).unref()),
      ]);
      this.drained = undefined;
    }
    server.closeIdleConnections();
    if (this.inFlightRequests > 0) server.closeAllConnections();
    await closed;
  }

  protected urlFor(token: string, port: number): string {
    return `http://${LOCAL_MCP_HOST}:${port}/${token}`;
  }

  protected async ensureListening(): Promise<number> {
    if (!this.server) {
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server.unref();
    }
    if (!this.listenPromise) {
      this.listenPromise = new Promise<void>((resolve, reject) => {
        const server = this.server!;
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error(`${this.hostName} MCP server did not bind to a TCP port`));
            return;
          }
          this.port = (address as AddressInfo).port;
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, LOCAL_MCP_HOST);
      });
    }
    await this.listenPromise;
    if (this.port === undefined) {
      throw new Error(`${this.hostName} MCP server has no listening port`);
    }
    return this.port;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = tokenOf(req);
    const server = token === undefined ? undefined : this.mcpServerFor(token, req, res);
    if (!server) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    this.inFlightRequests += 1;
    try {
      await server.connect(transport);
      // Resolves once the response body has been written in full (the SDK's Node listener awaits
      // the streamed body), so an async tool handler's result is on the wire before the teardown.
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(error instanceof Error ? error.message : String(error));
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    } finally {
      await Promise.allSettled([server.close(), transport.close()]);
      this.inFlightRequests -= 1;
      if (this.inFlightRequests === 0) this.drained?.();
    }
  }
}

/** The single path segment of the request URL, or undefined when the path is not exactly `/<token>`. */
function tokenOf(req: IncomingMessage): string | undefined {
  const rawUrl = req.url ?? "/";
  let pathname: string;
  try {
    pathname = new URL(rawUrl, `http://${LOCAL_MCP_HOST}`).pathname;
  } catch {
    return undefined;
  }
  if (!pathname.startsWith("/") || pathname.slice(1).includes("/")) return undefined;
  const token = pathname.slice(1);
  return token === "" ? undefined : token;
}
