import type {
    ClientContext,
    ContentBlock,
    LoadSessionResponse,
    NewSessionResponse,
    ResumeSessionResponse,
    SessionId,
} from "@agentclientprotocol/sdk";

export const LEGACY_SET_SESSION_MODEL_METHOD = "session/set_model";
export const SESSION_STEERING_METHOD = "_session/steering";
export const GOAL_CONTROL_METHOD = "_codex/session/goal_control";
export const LOADED_TURN_QUERY_METHOD = "_session/loaded_turn/query";
export const LOADED_TURN_ENDED_METHOD = "_session/loaded_turn/ended";

export type LegacySessionModel = {
    modelId: string;
    name: string;
    description?: string | null;
}

export type LegacySessionModelState = {
    availableModels: Array<LegacySessionModel>;
    currentModelId: string;
}

export type LegacySetSessionModelRequest = {
    sessionId: SessionId;
    modelId: string;
}

export type LegacySetSessionModelResponse = {}

export type LegacyNewSessionResponse = NewSessionResponse & {
    models?: LegacySessionModelState | null;
}

export type LegacyLoadSessionResponse = LoadSessionResponse & {
    models?: LegacySessionModelState | null;
}

export type LegacyResumeSessionResponse = ResumeSessionResponse & {
    models?: LegacySessionModelState | null;
}

export type ExtMethodRequest =
    AuthenticationStatusRequest
    | AuthenticationLogoutRequest
    | LegacySetSessionModelExtRequest
    | SessionSteeringExtRequest
    | GoalControlExtRequest
    | LoadedTurnQueryExtRequest

export function isExtMethodRequest(request: { method: string, params: Record<string, unknown> }): request is ExtMethodRequest {
    return request.method === "authentication/status"
        || request.method === "authentication/logout"
        || request.method === LEGACY_SET_SESSION_MODEL_METHOD
        || request.method === GOAL_CONTROL_METHOD
        || request.method === SESSION_STEERING_METHOD
        || request.method === LOADED_TURN_QUERY_METHOD;
}

export type AuthenticationStatusRequest = { method: "authentication/status", params: {} }
export type AuthenticationStatusResponse = { type: "api-key" } | { type: "chat-gpt", email: string } | { type: "gateway", name: string } | { type: "unauthenticated" }

export type AuthenticationLogoutRequest = { method: "authentication/logout", params: {} }
export type AuthenticationLogoutResponse = {}

export type LegacySetSessionModelExtRequest = {
    method: typeof LEGACY_SET_SESSION_MODEL_METHOD;
    params: LegacySetSessionModelRequest;
}

export type GoalControlRequest = {
    sessionId: SessionId;
    action: "pause" | "clear";
}

export type GoalControlExtRequest = {
    method: typeof GOAL_CONTROL_METHOD;
    params: GoalControlRequest;
}

export async function legacySetSessionModel(
    connection: Pick<ClientContext, "request">,
    params: LegacySetSessionModelRequest,
): Promise<LegacySetSessionModelResponse> {
    return await connection.request<LegacySetSessionModelResponse, LegacySetSessionModelRequest>(LEGACY_SET_SESSION_MODEL_METHOD, params);
}

export type SessionSteerRequest = {
    sessionId: SessionId;
    prompt: ContentBlock[];
}

export type SessionSteeringResponse = {
    outcome: "injected" | "startedNewTurn" | "failed";
}

export type SessionSteeringExtRequest = {
    method: typeof SESSION_STEERING_METHOD;
    params: SessionSteerRequest;
}

export async function steerSessionWithFallback(
    connection: Pick<ClientContext, "request">,
    params: SessionSteerRequest,
): Promise<SessionSteeringResponse> {
    return await connection.request<SessionSteeringResponse, SessionSteerRequest>(SESSION_STEERING_METHOD, params);
}

/**
 * The `_session/loaded_turn` vendor extension (the steering-extension
 * precedent): turn-TERMINAL state for loaded sessions — the REPL broker's
 * re-attach arm's authoritative completion evidence. `query` asks whether
 * the loaded session's founding turn is still running right now
 * (`"running"`), observably completed while the host was down
 * (`"completed"` — the replayed thread's last turn completed, so its
 * final message is authoritative), or ended without a terminal message
 * (`"interrupted"` — no turn is running, so re-issue is safe). The
 * `ended` notification is pushed when a turn that a query classified
 * `running` completes, with its stop reason or its error.
 */
export type LoadedTurnStatus = "completed" | "running" | "interrupted";

export type LoadedTurnQueryRequest = {
    sessionId: SessionId;
}

export type LoadedTurnQueryResponse = {
    status: LoadedTurnStatus;
}

export type LoadedTurnEndedNotification = {
    sessionId: SessionId;
    stopReason?: string;
    error?: { name: string; message: string };
}

export type LoadedTurnQueryExtRequest = {
    method: typeof LOADED_TURN_QUERY_METHOD;
    params: LoadedTurnQueryRequest;
}
