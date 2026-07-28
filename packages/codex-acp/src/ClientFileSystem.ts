import * as acp from "@agentclientprotocol/sdk";
import {readFile} from "node:fs/promises";
import type {AcpClientConnection} from "./ACPSessionConnection";
import type {FileContentReader} from "./CodexToolCallMapper";
import {logger} from "./Logger";

/**
 * File reads that respect the client's advertised `fs.readTextFile` capability.
 *
 * When the client advertises `fs.readTextFile` in its `clientCapabilities`
 * during `initialize`, file content is read through the client
 * (`fs/read_text_file`), so file-change diffs reflect unsaved editor buffers.
 * Otherwise reads fall back to the local file system. File WRITES are outside
 * this service's scope: codex applies changes to disk inside its own process
 * (the app-server protocol delegates no file IO to the client).
 */
export class ClientFileSystem {
    private readonly connection: AcpClientConnection;
    private readonly capabilities: acp.FileSystemCapabilities;

    constructor(
        connection: AcpClientConnection,
        capabilities?: acp.FileSystemCapabilities | null,
    ) {
        this.connection = connection;
        this.capabilities = capabilities ?? {};
    }

    get canReadTextFile(): boolean {
        return this.capabilities.readTextFile === true;
    }

    /**
     * Reads a text file, preferring the client's `fs/read_text_file` when the
     * capability is advertised. Falls back to a local read if the client
     * request fails (e.g. the file only exists on disk), and returns null when
     * the file cannot be read at all.
     */
    async readTextFile(sessionId: string, path: string): Promise<string | null> {
        if (this.canReadTextFile) {
            try {
                const response = await this.connection.request(
                    acp.methods.client.fs.readTextFile,
                    {sessionId, path},
                );
                return response.content;
            } catch (error) {
                logger.error(`Client fs/read_text_file failed for ${path}, falling back to local read`, error);
            }
        }
        return await readFile(path, {encoding: "utf8"}).catch(() => null);
    }

    /**
     * Binds {@link readTextFile} to a session for consumers that only need
     * file content, such as the file-change diff builder.
     */
    createFileReader(sessionId: string): FileContentReader {
        return (path) => this.readTextFile(sessionId, path);
    }
}
