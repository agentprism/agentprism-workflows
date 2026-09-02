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
            section: null,
            sectionEnteredAt: null,
            projectId: null,
            historyMode: "legacy",
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
                            delivery: null,
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
        // The push rides the session's update chain (review round 6) —
        // delivered asynchronously, ordered after any trailing deltas.
        await vi.waitFor(() => {
            expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([
                {method: LOADED_TURN_ENDED_METHOD, params: {sessionId: "session-1", stopReason: "end_turn"}},
            ]);
        });
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
        // The push rides the session's update chain (review round 6) —
        // delivered asynchronously.
        await vi.waitFor(() => {
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
    });

    it("settles a turn that ended BETWEEN load and query: the load-time watcher records the terminal marker, and the first `running` answer pushes the ended notification immediately (no missed completion, no stuck wait)", async () => {
        const fixture = setupFixture(baseThread("inProgress"));
        await load(fixture, "session-1");

        // The loaded active turn completes at the backend BEFORE any query
        // armed the watch: the watcher records the terminal marker.
        fixture.sendServerNotification(turnCompletedNotification("completed"));
        expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([]);

        // The query answers `running` (the turn WAS active at load) and the
        // recorded end settles immediately (the push rides the session's
        // update chain — delivered asynchronously, review round 6).
        const response = await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
            sessionId: "session-1",
        });
        expect(response).toEqual({status: "running"});
        await vi.waitFor(() => {
            expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([
                {method: LOADED_TURN_ENDED_METHOD, params: {sessionId: "session-1", stopReason: "end_turn"}},
            ]);
        });
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

    // ── Phase-D review round 5 regressions ───────────────────────────────

    /** The text chunks the ACP client would accumulate into its loaded-turn
     *  transcript: every `agent_message_chunk` session update on the wire
     *  (the replay's assistant messages plus the forwarded live deltas). */
    function accumulatedText(fixture: CodexMockTestFixture): string {
        return fixture
            .getAcpConnectionEvents([])
            .filter((event) => event.method === "sessionUpdate")
            .map((event) => (event.args[0] as {update: {sessionUpdate?: string; content?: {type?: string; text?: string}}}).update)
            .filter((update) => update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text")
            .map((update) => update.content?.text ?? "")
            .join("");
    }

    it("THE REVIEW REGRESSION (round 5/1): a loaded running turn's LIVE item/agentMessage/delta output is forwarded to the ACP client as agent_message_chunk updates — the seam's accumulated text is the replay partial PLUS the post-load deltas, never the replay-time partial", async () => {
        // The loaded thread's agent message is a PARTIAL answer (the
        // founding turn is still running at the backend).
        const thread = baseThread("inProgress");
        thread.turns[0]!.items[1] = {
            type: "agentMessage",
            id: "item-agent-1",
            text: "partial ",
            phase: null,
            memoryCitation: null,
            delivery: null,
        };
        const fixture = setupFixture(thread);
        await load(fixture, "session-1");
        expect(await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {sessionId: "session-1"})).toEqual({status: "running"});

        // The turn's live output streams at the backend AFTER the load.
        // The old watcher dropped every notification except
        // `turn/completed`, so the client settled the terminal
        // notification with only the replay-time partial text.
        fixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {threadId: "session-1", turnId: "turn-1", itemId: "item-agent-1", delta: "result C"},
        });
        // The forwarding is async (the per-session update chain): wait for
        // the delta to reach the recorded ACP connection.
        await vi.waitFor(() => {
            expect(accumulatedText(fixture)).toBe("partial result C");
        });
        // The turn's terminal marker then settles the wait — the client's
        // accumulated transcript at that point is the turn's REAL outcome.
        fixture.sendServerNotification(turnCompletedNotification("completed"));
        // The push rides the session's update chain (review round 6) —
        // delivered asynchronously, ordered after the delta.
        await vi.waitFor(() => {
            expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([
                {method: LOADED_TURN_ENDED_METHOD, params: {sessionId: "session-1", stopReason: "end_turn"}},
            ]);
        });
        expect(accumulatedText(fixture)).toBe("partial result C");
    });

    it("THE REVIEW REGRESSION (round 6/1): a turn/completed arriving BACK-TO-BACK with the final live delta delivers the delta FIRST — the terminal marker rides the session's update chain, so the re-attach seam never settles partial text", async () => {
        // The loaded thread's agent message is a PARTIAL answer (the
        // founding turn is still running at the backend).
        const thread = baseThread("inProgress");
        thread.turns[0]!.items[1] = {
            type: "agentMessage",
            id: "item-agent-1",
            text: "partial ",
            phase: null,
            memoryCitation: null,
            delivery: null,
        };
        const fixture = setupFixture(thread);
        await load(fixture, "session-1");
        expect(await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {sessionId: "session-1"})).toEqual({status: "running"});

        // The turn's final delta and its terminal marker arrive
        // BACK-TO-BACK, with NO wait between them — the old watcher
        // pushed the ended notification SYNCHRONOUSLY while the delta
        // was still queued on the async per-session update chain, so the
        // ACP client received the terminal marker first and the re-attach
        // seam durably settled the replay-time PARTIAL text.
        fixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {threadId: "session-1", turnId: "turn-1", itemId: "item-agent-1", delta: "result C"},
        });
        fixture.sendServerNotification(turnCompletedNotification("completed"));

        // Both reach the ACP client; the delta MUST be recorded before
        // the ended notification (the marker rides the same per-session
        // update chain the delta forwarding uses).
        await vi.waitFor(() => {
            expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([
                {method: LOADED_TURN_ENDED_METHOD, params: {sessionId: "session-1", stopReason: "end_turn"}},
            ]);
        });
        const events = fixture.getAcpConnectionEvents([]);
        const updateOf = (event: MethodCallEvent): {sessionUpdate?: string; content?: {type?: string; text?: string}} | undefined =>
            (event.args[0] as {update?: {sessionUpdate?: string; content?: {type?: string; text?: string}}}).update;
        const deltaIndex = events.findIndex((event) =>
            event.method === "sessionUpdate"
            && updateOf(event)?.sessionUpdate === "agent_message_chunk"
            && updateOf(event)?.content?.text === "result C");
        const endedIndex = events.findIndex(
            (event) => event.method === "notify" && event.args[0] === LOADED_TURN_ENDED_METHOD,
        );
        expect(deltaIndex).toBeGreaterThanOrEqual(0);
        expect(endedIndex).toBeGreaterThan(deltaIndex);
        expect(accumulatedText(fixture)).toBe("partial result C");
    });

    it("THE REVIEW REGRESSION (round 5/2): a turn/completed arriving in the load WINDOW (after the stale threadRead response, before the watcher installs) is buffered and settles the first `running` answer immediately — never discarded, never permanently classified as running", async () => {
        const fixture = setupFixture(baseThread("inProgress"));
        // Park the load AFTER threadResume+threadRead have resolved (the
        // stale thread snapshot) and BEFORE the watcher installs: the
        // model-fetch gate below. The old code dropped the window's
        // completion (the per-session handler dispatch found no handler).
        let releaseModels!: () => void;
        const parked = new Promise<void>((resolve) => {
            releaseModels = resolve;
        });
        const appServerClient = fixture.getCodexAppServerClient();
        const originalListModels = appServerClient.listModels;
        appServerClient.listModels = vi.fn(async (params: Parameters<typeof originalListModels>[0]) => {
            await parked;
            return originalListModels(params);
        });
        const loadPromise = load(fixture, "session-1");
        // Wait until the stale threadRead has resolved (the load is now
        // parked at the model gate — the window is open).
        await vi.waitFor(() => {
            expect(appServerClient.threadRead).toHaveBeenCalled();
        });
        // The loaded active turn completes IN THE WINDOW.
        fixture.sendServerNotification(turnCompletedNotification("completed"));
        releaseModels();
        await loadPromise;
        // The buffered completion settles the first `running` answer
        // immediately (the load-time watcher recorded it, first-wins).
        const response = await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
            sessionId: "session-1",
        });
        expect(response).toEqual({status: "running"});
        // The push rides the session's update chain (review round 6) —
        // delivered asynchronously.
        await vi.waitFor(() => {
            expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([
                {method: LOADED_TURN_ENDED_METHOD, params: {sessionId: "session-1", stopReason: "end_turn"}},
            ]);
        });
    });

    it("THE REVIEW REGRESSION (round 5/3): an `active` thread with a completed last turn answers `running`, and the ACTIVE turn's differently identified completion TERMINATES it (the old watcher matched the already-completed last turn's id and never fired — the running answer never ended)", async () => {
        const fixture = setupFixture(baseThread("completed", {type: "active", activeFlags: []}));
        await load(fixture, "session-1");
        const response = await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {
            sessionId: "session-1",
        });
        expect(response).toEqual({status: "running"});
        // The ACTUAL active turn's id differs from the loaded (stale) last
        // turn's id — its completion must settle the running answer.
        fixture.sendServerNotification({
            method: "turn/completed",
            params: {
                threadId: "session-1",
                turn: {
                    id: "turn-active-9",
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
        // The push rides the session's update chain (review round 6) —
        // delivered asynchronously, ordered after any trailing deltas.
        await vi.waitFor(() => {
            expect(endedNotifications(fixture.getAcpConnectionEvents([]))).toEqual([
                {method: LOADED_TURN_ENDED_METHOD, params: {sessionId: "session-1", stopReason: "end_turn"}},
            ]);
        });
        // The detection cleared: a later query classifies from the ended
        // turn's status, and a second completion pushes nothing.
        expect(await fixture.getCodexAcpAgent().extMethod(LOADED_TURN_QUERY_METHOD, {sessionId: "session-1"})).toEqual({status: "completed"});
        fixture.clearAcpConnectionDump();
        fixture.sendServerNotification({
            method: "turn/completed",
            params: {
                threadId: "session-1",
                turn: {
                    id: "turn-another",
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
});
