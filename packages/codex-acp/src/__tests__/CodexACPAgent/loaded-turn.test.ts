import {describe, it, expect, vi} from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {
    createCodexMockTestFixture,
    createSmartMock,
    createTestModel,
    createTestSessionState,
    type MethodCallEvent,
} from "../acp-test-utils";
import type {Thread} from "../../app-server/v2";
import {CodexEventHandler} from "../../CodexEventHandler";
import {LOADED_TURN_ENDED_METHOD, LOADED_TURN_QUERY_METHOD} from "../../AcpExtensions";
import type {AcpClientConnection} from "../../ACPSessionConnection";

/**
 * The `_session/loaded_turn` extension (the REPL broker's re-attach arm's
 * authoritative completion evidence): the query answers whether the
 * loaded session's founding turn is still running right now, and the
 * ended notification is pushed when a turn that a query classified
 * `running` completes (with its stop reason or its error).
 */
describe("CodexACPAgent - _session/loaded_turn extension", () => {
    function baseThread(turnStatus: Thread["turns"][number]["status"]): Thread {
        return {
            id: "session-1",
            sessionId: "session-1",
            parentThreadId: null,
            threadSource: null,
            forkedFromId: null,
            preview: "Hi",
            ephemeral: false,
            isPinned: false,
            modelProvider: "openai",
            createdAt: 123,
            updatedAt: 124,
            recencyAt: null,
            status: {type: "idle"},
            path: null,
            cwd: "/test/project",
            cliVersion: "0.0.0",
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [
                {
                    id: "turn-1",
                    itemsView: "full",
                    status: turnStatus,
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                    items: [
                        {
                            type: "userMessage",
                            id: "item-user-1",
                            clientId: null,
                            content: [{type: "text", text: "Hi", text_elements: []}],
                        },
                        {
                            type: "agentMessage",
                            id: "item-agent-1",
                            text: "Hello!",
                            phase: null,
                            memoryCitation: null,
                        },
                    ],
                },
            ],
        };
    }

    function setupFixture(thread: Thread) {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({data: []});
        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [createTestModel()],
            nextCursor: null,
        });
        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread: thread,
            model: "gpt-5.2",
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: {type: "dangerFullAccess"},
            reasoningEffort: "medium",
        });
        codexAppServerClient.threadRead = vi.fn().mockResolvedValue({thread: thread});
        codexAppServerClient.threadGoalGet = vi.fn().mockResolvedValue({
            goal: null,
        });
        return fixture;
    }

    async function load(fixture: ReturnType<typeof setupFixture>, threadId: string): Promise<void> {
        await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
        const loadParams: acp.LoadSessionRequest = {
            sessionId: threadId,
            cwd: "/test/project",
            mcpServers: [],
        };
        await fixture.getCodexAcpAgent().loadSession(loadParams);
    }

    it("answers `completed` when the loaded thread's last turn completed (the replay's final message is the founding turn's FINAL message — settle is authoritative)", async () => {
        const fixture = setupFixture(baseThread("completed"));
        await load(fixture, "session-1");

        const response = await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
            sessionId: "session-1",
        });
        expect(response).toEqual({status: "completed"});
    });

    it("answers `interrupted` when the loaded thread's last turn is inProgress/interrupted/failed — nothing is running, so re-issue is safe", async () => {
        for (const status of ["inProgress", "interrupted", "failed"] as const) {
            const fixture = setupFixture(baseThread(status));
            await load(fixture, "session-1");
            const response = await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
                sessionId: "session-1",
            });
            expect(response).toEqual({status: "interrupted"});
        }
    });

    it("answers `running` while a turn executes in-process and pushes the ended notification with the stop reason when the turn completes", async () => {
        const fixture = setupFixture(baseThread("completed"));
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await load(fixture, "session-1");

        // A turn starts in-process (the loaded session's founding turn is
        // still executing at the backend — the re-attach arm's live case).
        const sessionState = codexAcpAgent.getSessionState("session-1")!;
        sessionState.currentTurnId = "turn-2";
        const response = await codexAcpAgent.extMethod(LOADED_TURN_QUERY_METHOD, {
            sessionId: "session-1",
        });
        expect(response).toEqual({status: "running"});

        // The turn completes: the handler pushes the authoritative ended
        // notification with the mapped stop reason and clears the watch.
        const notifications: Array<{method: string; params: unknown}> = [];
        const connection = createSmartMock<AcpClientConnection>((event: MethodCallEvent) => {
            if (event.method === "notify") {
                notifications.push({method: event.args[0] as string, params: event.args[1]});
            }
        });
        const eventHandler = new CodexEventHandler(connection, sessionState);
        await eventHandler.handleNotification({
            method: "turn/completed",
            params: {
                threadId: "session-1",
                turn: {
                    id: "turn-2",
                    itemsView: "full",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                    items: [],
                },
            },
        });
        expect(notifications).toContainEqual({
            method: LOADED_TURN_ENDED_METHOD,
            params: {sessionId: "session-1", stopReason: "end_turn"},
        });
        expect(sessionState.loadedTurnReportedRunning).toBe(false);
        // The watch is one-shot: a later turn completion pushes nothing.
        notifications.length = 0;
        await eventHandler.handleNotification({
            method: "turn/completed",
            params: {
                threadId: "session-1",
                turn: {
                    id: "turn-3",
                    itemsView: "full",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                    items: [],
                },
            },
        });
        expect(notifications.some((n) => n.method === LOADED_TURN_ENDED_METHOD)).toBe(false);
    });

    it("pushes the ended notification with the turn's error for a failed running turn (the client rejects the founding call instead of settling)", async () => {
        const fixture = setupFixture(baseThread("completed"));
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await load(fixture, "session-1");
        const sessionState = codexAcpAgent.getSessionState("session-1")!;
        sessionState.currentTurnId = "turn-2";
        await codexAcpAgent.extMethod(LOADED_TURN_QUERY_METHOD, {sessionId: "session-1"});

        const notifications: Array<{method: string; params: unknown}> = [];
        const connection = createSmartMock<AcpClientConnection>((event: MethodCallEvent) => {
            if (event.method === "notify") {
                notifications.push({method: event.args[0] as string, params: event.args[1]});
            }
        });
        const eventHandler = new CodexEventHandler(connection, sessionState);
        await eventHandler.handleNotification({
            method: "turn/completed",
            params: {
                threadId: "session-1",
                turn: {
                    id: "turn-2",
                    itemsView: "full",
                    status: "failed",
                    error: {message: "model blew up", codexErrorInfo: null, additionalDetails: null},
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                    items: [],
                },
            },
        });
        expect(notifications).toContainEqual({
            method: LOADED_TURN_ENDED_METHOD,
            params: {
                sessionId: "session-1",
                error: {name: "TurnError", message: "model blew up"},
            },
        });
    });

    it("rejects the query for an unknown session", async () => {
        const fixture = setupFixture(baseThread("completed"));
        await load(fixture, "session-1");
        await expect(
            fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {sessionId: "nope"}),
        ).rejects.toMatchObject({code: -32602});
    });
});
