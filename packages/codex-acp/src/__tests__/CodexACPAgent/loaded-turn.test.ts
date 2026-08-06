import {describe, it, expect, vi} from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {
    createCodexMockTestFixture,
    createTestModel,
    type CodexMockTestFixture,
    type MethodCallEvent,
} from "../acp-test-utils";
import type {Thread} from "../../app-server/v2";
import {LOADED_TURN_ENDED_METHOD, LOADED_TURN_QUERY_METHOD} from "../../AcpExtensions";

/**
 * The `_session/loaded_turn` extension (the REPL broker's re-attach arm's
 * authoritative completion evidence): the query answers whether the
 * loaded session's founding turn is still running right now, and the
 * ended notification is pushed when a turn that a query classified
 * `running` completes (with its stop reason or its error).
 *
 * The loaded-session `running` classification is the AUTHORITATIVE
 * LOAD-TIME ACTIVE-TURN DETECTION (phase-D review): `session/load`
 * inspects the loaded thread — its runtime status `active` and/or its
 * last turn `inProgress` — for a founding turn that may still be running
 * at the backend (the codex thread store is shared across processes, so
 * an `inProgress` turn on disk NEVER proves it died with this host), and
 * a per-session load-time watcher subscribes to that turn's
 * `turn/completed` terminal marker. The old implementation initialized
 * `currentTurnId` to null at load and mapped a persisted `inProgress`
 * turn to `interrupted` — the broker re-issued potentially active work.
 * All loaded-session cases below run END TO END through the real
 * initialize → session/load → query → server-notification path, with no
 * internal session-state mutation.
 */
describe("CodexACPAgent - _session/loaded_turn extension", () => {
    function baseThread(turnStatus: Thread["turns"][number]["status"], threadStatus: Thread["status"] = {type: "idle"}): Thread {
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
            status: threadStatus,
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

    async function load(fixture: CodexMockTestFixture, threadId: string): Promise<void> {
        await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
        const loadParams: acp.LoadSessionRequest = {
            sessionId: threadId,
            cwd: "/test/project",
            mcpServers: [],
        };
        await fixture.getCodexAcpAgent().loadSession(loadParams);
    }

    function endedNotifications(events: MethodCallEvent[]): Array<{method: string; params: unknown}> {
        return events
            .filter((event) => event.method === "notify" && event.args[0] === LOADED_TURN_ENDED_METHOD)
            .map((event) => ({method: event.args[0] as string, params: event.args[1]}));
    }

    function turnCompletedNotification(turnStatus: "completed" | "interrupted" | "failed"): Record<string, unknown> {
        return {
            method: "turn/completed",
            params: {
                threadId: "session-1",
                turn: {
                    id: "turn-1",
                    itemsView: "full",
                    status: turnStatus,
                    error: turnStatus === "failed" ? {message: "model blew up"} : null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                    items: [],
                },
            },
        };
    }

    it("answers `completed` when the loaded thread's last turn completed (the replay's final message is the founding turn's FINAL message — settle is authoritative)", async () => {
        const fixture = setupFixture(baseThread("completed"));
        await load(fixture, "session-1");

        const response = await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
            sessionId: "session-1",
        });
        expect(response).toEqual({status: "completed"});
    });

    it("answers `interrupted` when the loaded thread's last turn is interrupted/failed and the thread is idle — nothing is running, so re-issue is safe", async () => {
        for (const status of ["interrupted", "failed"] as const) {
            const fixture = setupFixture(baseThread(status));
            await load(fixture, "session-1");
            const response = await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
                sessionId: "session-1",
            });
            expect(response).toEqual({status: "interrupted"});
        }
    });

    it("THE REVIEW REGRESSION: a persisted `inProgress` last turn answers `running` — the authoritative load-time active-turn detection — never the re-issue-unsafe `interrupted` mapping (the codex thread store is shared across processes, so the founding turn may still be running at the backend)", async () => {
        const fixture = setupFixture(baseThread("inProgress"));
        await load(fixture, "session-1");

        const response = await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
            sessionId: "session-1",
        });
        expect(response).toEqual({status: "running"});
        // The query armed the watch: the ended notification must fire when
        // the loaded active turn's terminal marker arrives — end to end
        // through the server-notification path, no internal mutation.
        fixture.sendServerNotification(turnCompletedNotification("completed"));
        expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([
            {method: LOADED_TURN_ENDED_METHOD, params: {sessionId: "session-1", stopReason: "end_turn"}},
        ]);
        // The watch is one-shot: a later turn completion for another turn
        // pushes nothing.
        fixture.clearAcpConnectionDump();
        fixture.sendServerNotification({
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
        expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([]);
    });

    it("answers `running` when the loaded thread's runtime status is `active` even if its last turn reads completed (the app-server's runtime status is the authoritative still-running signal)", async () => {
        const fixture = setupFixture(baseThread("completed", {type: "active", activeFlags: []}));
        await load(fixture, "session-1");

        const response = await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
            sessionId: "session-1",
        });
        expect(response).toEqual({status: "running"});
    });

    it("pushes the ended notification with the turn's error when the loaded active turn FAILS at the backend (the client rejects the founding call instead of settling)", async () => {
        const fixture = setupFixture(baseThread("inProgress"));
        await load(fixture, "session-1");

        await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
            sessionId: "session-1",
        });
        fixture.sendServerNotification(turnCompletedNotification("failed"));
        expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([
            {
                method: LOADED_TURN_ENDED_METHOD,
                params: {
                    sessionId: "session-1",
                    error: {name: "TurnError", message: "model blew up"},
                },
            },
        ]);
    });

    it("settles a turn that ended BETWEEN load and query: the load-time watcher records the terminal marker, and the first `running` answer pushes the ended notification immediately (no missed completion, no stuck wait)", async () => {
        const fixture = setupFixture(baseThread("inProgress"));
        await load(fixture, "session-1");

        // The loaded active turn completes at the backend BEFORE any query
        // armed the watch: the watcher records the terminal marker.
        fixture.sendServerNotification(turnCompletedNotification("completed"));
        expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([]);

        // The query answers `running` (the turn WAS active at load) and the
        // recorded end settles immediately.
        const response = await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
            sessionId: "session-1",
        });
        expect(response).toEqual({status: "running"});
        expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([
            {method: LOADED_TURN_ENDED_METHOD, params: {sessionId: "session-1", stopReason: "end_turn"}},
        ]);
    });

    it("answers `running` while a turn executes in-process (the `turn/started` set `currentTurnId`)", async () => {
        const fixture = setupFixture(baseThread("completed"));
        await load(fixture, "session-1");

        // The in-process turn state: `turn/started` sets currentTurnId in
        // production; the query classifies it `running` (the armed watch's
        // ended push then fires from the prompt handler's turn/completed).
        const sessionState = fixture.getCodexAcpAgent().getSessionState("session-1")!;
        sessionState.currentTurnId = "turn-2";
        const response = await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
            sessionId: "session-1",
        });
        expect(response).toEqual({status: "running"});
        expect(sessionState.loadedTurnReportedRunning).toBe(true);
    });

    it("rejects the query for an unknown session", async () => {
        const fixture = setupFixture(baseThread("completed"));
        await load(fixture, "session-1");
        await expect(
            fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {sessionId: "nope"}),
        ).rejects.toMatchObject({code: -32602});
    });
});
