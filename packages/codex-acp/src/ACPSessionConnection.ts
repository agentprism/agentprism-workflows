import * as acp from "@agentclientprotocol/sdk";
import {
    type AcpSessionUpdate,
    asSdkSessionNotification,
} from "./AcpSessionExtensions";

export type AcpClientConnection = Pick<acp.AgentContext, "notify" | "request">;

export class ACPSessionConnection {
    private readonly connection: AcpClientConnection;
    readonly sessionId: string;

    constructor(connection: AcpClientConnection, sessionId: string) {
        this.connection = connection;
        this.sessionId = sessionId;
    }

    async update(update: UpdateSessionEvent, sessionId: string = this.sessionId) {
        await this.connection.notify(acp.methods.client.session.update, asSdkSessionNotification({
            sessionId,
            update: update
        }));
    }

    /** Vendor-extension notification (e.g. `_session/loaded_turn/ended`),
     *  stamped with this session's id by the caller's params. */
    async notify<Params = unknown>(method: string, params: Params) {
        await this.connection.notify(method, params);
    }
}

export type UpdateSessionEvent = AcpSessionUpdate;
