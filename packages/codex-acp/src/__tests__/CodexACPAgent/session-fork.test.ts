import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

describe("ACP session fork", () => {
    it("creates and installs a forked session", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const model = createTestModel({id: "gpt-5"});

        vi.spyOn(client, "authRequired").mockResolvedValue(false);
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        const forkSpy = vi.spyOn(client, "forkSession").mockResolvedValue({
            sessionId: "fork-id",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: [],
        });

        const response = await agent.forkSession({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        });

        expect(response.sessionId).toBe("fork-id");
        expect(agent.getSessionState("fork-id").cwd).toBe("/workspace");
        // Forking creates a session, so the connection reports the account it was
        // created under (`authStatus` extension).
        expect(fixture.getAcpConnectionEvents([])).toContainEqual({
            method: "notify",
            args: ["_auth/status_update", {authStatus: {kind: "none", label: "Not logged in"}}],
        });
        // The fork is a LIVE session: it publishes its available commands like a new or
        // resumed session does (published asynchronously after the fork response).
        await vi.waitFor(() => {
            const published = fixture.getAcpConnectionEvents([]).some(event =>
                event.method === "sessionUpdate"
                && (event.args[0] as {sessionId?: string; update?: {sessionUpdate?: string}}).sessionId === "fork-id"
                && (event.args[0] as {update?: {sessionUpdate?: string}}).update?.sessionUpdate === "available_commands_update");
            expect(published).toBe(true);
        });
        expect(forkSpy).toHaveBeenCalledWith({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        });
    });

    it("unsubscribes the forked thread when the open fails after thread/fork returned, leaving no session state", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const model = createTestModel({id: "gpt-5"});

        vi.spyOn(client, "authRequired").mockResolvedValue(false);
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(client, "forkSession").mockResolvedValue({
            sessionId: "fork-id",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: [],
        });
        // thread/fork has already subscribed this connection to "fork-id" when the auth-state read
        // that follows it fails (getAuthStateForProvider → getAccount).
        vi.spyOn(client, "getAccount").mockRejectedValue(new Error("account lookup failed"));
        const unsubscribeSpy = vi.spyOn(fixture.getCodexAppServerClient(), "threadUnsubscribe")
            .mockResolvedValue({} as never);

        await expect(agent.forkSession({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        })).rejects.toThrow("account lookup failed");

        // The failed open released the forked thread's subscription exactly like a failed resume
        // does (cleanupStaleSessionOpen → closeSession → thread/unsubscribe) ...
        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(unsubscribeSpy).toHaveBeenCalledWith({threadId: "fork-id"});
        // ... and installed nothing for the id it never handed out.
        expect(() => agent.getSessionState("fork-id")).toThrow("Session fork-id not found");
    });
});
