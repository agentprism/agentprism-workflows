import {describe, expect, it, vi} from "vitest";
import {shouldGenerateSessionTitle, TitleGenerator} from "../TitleGenerator";
import type {CodexAppServerClient} from "../CodexAppServerClient";

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>(innerResolve => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}

function createGenerator(client: Partial<CodexAppServerClient>) {
    return new TitleGenerator(client as CodexAppServerClient, "thread-id", "/test/cwd", () => "unset");
}

describe("TitleGenerator.waitForIdle", () => {
    it("returns immediately when nothing is generating", async () => {
        const generator = createGenerator({});

        await expect(generator.waitForIdle(50)).resolves.toBeUndefined();
    });

    it("waits for the rename echo notification before settling", async () => {
        const turn = deferred<{turn: {items: {type: string; text: string}[]}}>();
        const threadSetName = vi.fn().mockResolvedValue({});
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn: vi.fn().mockReturnValue(turn.promise),
            threadSetName,
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");
        let settled = false;
        const idle = generator.waitForIdle(5_000).then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        turn.resolve({turn: {items: [{type: "agentMessage", text: '{"title":"A short title"}'}]}});
        // Flush the microtask chain (extract title -> threadSetName -> start
        // waiting for the echo) without resolving the echo itself yet.
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
        }
        expect(threadSetName).toHaveBeenCalledWith({threadId: "thread-id", name: "A short title"});
        expect(settled).toBe(false);

        // The thread/name/updated notification for this rename arrives.
        generator.observeRename();
        await idle;
        expect(settled).toBe(true);
    });

    it("gives up after the timeout rather than holding the caller open", async () => {
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn: vi.fn().mockReturnValue(new Promise(() => {})),
            threadSetName: vi.fn(),
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");

        await expect(generator.waitForIdle(20)).resolves.toBeUndefined();
    });

    it("stops waiting once a failed generation has settled", async () => {
        const generator = createGenerator({
            threadStart: vi.fn().mockRejectedValue(new Error("no ephemeral threads")),
            runTurn: vi.fn(),
            threadSetName: vi.fn(),
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");

        await expect(generator.waitForIdle(5_000)).resolves.toBeUndefined();
    });
});


describe("workflow title-generation fence", () => {
    it("keeps interactive sessions eligible while excluding engine-stamped workflow sessions", () => {
        expect(shouldGenerateSessionTitle(undefined)).toBe(true);
        expect(shouldGenerateSessionTitle({theme: "dark"})).toBe(true);
        expect(shouldGenerateSessionTitle({runId: "mthm2pfn-30qvj2"})).toBe(false);
    });

    it("does not mistake malformed or empty metadata for an engine run", () => {
        expect(shouldGenerateSessionTitle(null)).toBe(true);
        expect(shouldGenerateSessionTitle([])).toBe(true);
        expect(shouldGenerateSessionTitle({runId: ""})).toBe(true);
        expect(shouldGenerateSessionTitle({runId: 7})).toBe(true);
    });
});
