import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  AgentRunner,
  AgentSessionRecord,
  JournalEntry,
  RunOptions,
  WorkflowCallRecord,
  WorkflowRunFallback,
} from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { ContinuationCandidate, PreparedContinuation, PreparedResume } from "../src/resume.js";
import { runWorkflow } from "../src/workflow.js";

const workflow = (options = "", body = "return await agent('task', { label: 'worker' })") =>
  `export const meta = { name: "continuation", description: "continuation tests" }
${body.replace("{ label: 'worker' }", `{ label: 'worker'${options ? `, ${options}` : ""} }`)}`;

function tempCwd(prefix = "continuation-"): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function initGitCwd(): { cwd: string; cleanup: () => void } {
  const fixture = tempCwd("continuation-git-");
  execFileSync("git", ["-C", fixture.cwd, "init", "-q"]);
  execFileSync("git", ["-C", fixture.cwd, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", fixture.cwd, "config", "user.name", "Tests"]);
  writeFileSync(join(fixture.cwd, "tracked.txt"), "tracked\n");
  execFileSync("git", ["-C", fixture.cwd, "add", "tracked.txt"]);
  execFileSync("git", ["-C", fixture.cwd, "commit", "-qm", "initial"]);
  return fixture;
}

interface InterruptedRecording {
  call: WorkflowCallRecord;
  session: AgentSessionRecord;
  candidate: ContinuationCandidate;
}

async function recordInterrupted(
  cwd: string,
  script = workflow(),
  code: WorkflowErrorCode = WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
): Promise<InterruptedRecording> {
  const calls: WorkflowCallRecord[] = [];
  let session: AgentSessionRecord | undefined;
  await assert.rejects(runWorkflow(script, {
    runId: "paused-source",
    cwd,
    persistLogs: false,
    agent: {
      async run(_prompt, options) {
        options.onSessionOpen?.({
          sessionId: "paused-session",
          backendId: "test-backend",
          poolKey: "test-backend",
          cwd: code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT ? options.cwd ?? cwd : options.cwd ?? cwd,
          reopen: { load: true, resume: true, list: true },
        });
        throw new WorkflowError("pause", code, { recoverable: false });
      },
    },
    onCallRecord: (call) => calls.push(call),
    onAgentEnd: (event) => {
      session = event.session;
    },
  }));
  assert.equal(calls.length, 1);
  assert.ok(session);
  assert.equal(session.keptOpen, true, "pause-class releases are recorded as kept open");
  assert.equal(calls[0]?.outcome, "error");
  assert.ok(calls[0]?.inputsHash);
  const call = calls[0] as WorkflowCallRecord;
  return {
    call,
    session,
    candidate: {
      callIndex: call.index,
      hash: call.hash,
      inputsHash: call.inputsHash,
      sessionRef: session,
      recordedCwd: call.resolvedCwd ?? session.cwd,
    },
  };
}

function prepared(candidate: ContinuationCandidate): PreparedContinuation {
  return { candidatesByIndex: new Map([[candidate.callIndex, candidate]]) };
}

function legacyInputsHash(overrides: Record<string, unknown> = {}): string {
  const canonical = JSON.stringify({
    backends: null,
    cwd: null,
    images: null,
    isolation: null,
    keepSession: false,
    label: "worker",
    mcpServers: null,
    meta: null,
    promptMeta: null,
    retries: 1,
    timeoutMs: null,
    ...overrides,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function continuedRunner(
  candidate: ContinuationCandidate,
  continuation: NonNullable<Parameters<NonNullable<RunOptions["onResultProvenance"]>>[0]>["continuation"] = {
    reattached: true,
    method: "resume",
  },
): AgentRunner {
  return {
    async run(_prompt, options) {
      assert.deepEqual(options.continueFromSession, candidate.sessionRef);
      options.onResultProvenance?.({ source: "live", continuation });
      options.onSessionOpen?.({
        ...candidate.sessionRef,
        sessionId: "continued-session",
      });
      return "continued";
    },
  };
}

describe("live-boundary continuation", () => {
  it("passes an eligible candidate only on attempt one, emits a guarded reattach notice, and journals the marker", async () => {
    const fixture = tempCwd();
    try {
      const source = await recordInterrupted(fixture.cwd);
      const fallbacks: WorkflowRunFallback[] = [];
      const journal: JournalEntry[] = [];
      const result = await runWorkflow(workflow(), {
        runId: "continued-target",
        cwd: fixture.cwd,
        persistLogs: false,
        agent: continuedRunner(source.candidate),
        preparedContinuation: prepared(source.candidate),
        onFallback: (fallback) => {
          fallbacks.push(fallback);
          throw new Error("observer failure must be isolated");
        },
        onAgentJournal: (entry) => journal.push(entry),
      });

      assert.equal(result.result, "continued");
      assert.deepEqual(fallbacks, [{
        callIndex: 0,
        label: "worker",
        requestedSpec: "(default)",
        backendId: "test-backend",
        kind: "continuation",
        continuation: { outcome: "reattached", method: "resume" },
        message: "continuation: reattached via session/resume",
      }]);
      assert.deepEqual(journal[0]?.call?.kind === "agent" ? journal[0].call.continuation : undefined, {
        method: "resume",
      });
      assert.deepEqual(
        [result.calls?.[0]?.index, result.calls?.[0]?.kind, result.calls?.[0]?.hash],
        [source.call.index, source.call.kind, source.call.hash],
        "continuation does not change journal identity",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("emits every engine-gate reason before running fresh", async () => {
    const fixture = tempCwd();
    const git = initGitCwd();
    try {
      const source = await recordInterrupted(fixture.cwd);
      const missing = join(fixture.cwd, "removed-cwd");
      mkdirSync(missing);
      const missingSource = await recordInterrupted(fixture.cwd, workflow("cwd: 'removed-cwd'"));
      rmSync(missing, { recursive: true, force: true });
      const worktreeSource = await recordInterrupted(git.cwd, workflow("isolation: 'worktree'"));
      const cases: Array<{
        reason: "hash-mismatch" | "inputs-mismatch" | "cwd-mismatch" | "cwd-missing" | "worktree-isolated";
        script: string;
        cwd: string;
        candidate: ContinuationCandidate;
      }> = [
        { reason: "hash-mismatch", script: workflow(), cwd: fixture.cwd, candidate: { ...source.candidate, hash: "changed" } },
        { reason: "inputs-mismatch", script: workflow(), cwd: fixture.cwd, candidate: { ...source.candidate, inputsHash: "changed" } },
        { reason: "inputs-mismatch", script: workflow(), cwd: fixture.cwd, candidate: { ...source.candidate, inputsHash: undefined } },
        { reason: "cwd-mismatch", script: workflow(), cwd: fixture.cwd, candidate: { ...source.candidate, recordedCwd: join(fixture.cwd, "other") } },
        { reason: "cwd-missing", script: workflow("cwd: 'removed-cwd'"), cwd: fixture.cwd, candidate: missingSource.candidate },
        { reason: "worktree-isolated", script: workflow("isolation: 'worktree'"), cwd: git.cwd, candidate: worktreeSource.candidate },
      ];

      for (const item of cases) {
        const fallbacks: WorkflowRunFallback[] = [];
        let calls = 0;
        const result = await runWorkflow(item.script, {
          cwd: item.cwd,
          persistLogs: false,
          preparedContinuation: prepared(item.candidate),
          agent: {
            async run(_prompt, options) {
              calls += 1;
              assert.equal(options.continueFromSession, undefined);
              return "fresh";
            },
          },
          onFallback: (fallback) => fallbacks.push(fallback),
        });
        assert.equal(result.result, "fresh");
        assert.equal(calls, 1);
        assert.deepEqual(fallbacks[0]?.continuation, { outcome: "skipped", reason: item.reason });
        assert.equal(fallbacks.length, 1);
      }
    } finally {
      fixture.cleanup();
      git.cleanup();
    }
  });

  it("fails to fresh when any unhashed execution input changes or the live fingerprint is absent", async () => {
    const fixture = tempCwd();
    try {
      mkdirSync(join(fixture.cwd, "changed-cwd"));
      const source = await recordInterrupted(fixture.cwd);
      const changed: Array<{
        name: string;
        script: string;
        scriptBackends?: Record<string, { command: string }>;
      }> = [
        { name: "images", script: workflow(`images: [{ data: "YQ==", mimeType: "image/png" }]`) },
        { name: "mcpServers", script: workflow(`mcpServers: [{ name: "tools", command: "tool-server" }]`) },
        { name: "promptMeta", script: workflow(`promptMeta: { trace: "changed" }`) },
        { name: "meta", script: workflow(`meta: { trace: "changed" }`) },
        { name: "keepSession", script: workflow("keepSession: true") },
        {
          name: "label",
          script: workflow("", `return await agent('task', { label: 'changed-label' })`),
        },
        { name: "cwd", script: workflow(`cwd: "changed-cwd"`) },
        {
          name: "script backend digest",
          script: workflow(),
          scriptBackends: { custom: { command: "changed-command" } },
        },
        { name: "missing live fingerprint", script: workflow("meta: { invalid: undefined }") },
      ];

      for (const item of changed) {
        const fallbacks: WorkflowRunFallback[] = [];
        await runWorkflow(item.script, {
          cwd: fixture.cwd,
          persistLogs: false,
          preparedContinuation: prepared(source.candidate),
          scriptBackends: item.scriptBackends,
          agent: {
            async run(_prompt, options) {
              assert.equal(options.continueFromSession, undefined, item.name);
              return "fresh";
            },
          },
          onFallback: (fallback) => fallbacks.push(fallback),
        });
        assert.deepEqual(
          fallbacks[0]?.continuation,
          { outcome: "skipped", reason: "inputs-mismatch" },
          item.name,
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps an interrupted occurrence eligible when timeout or retry bounds change", async () => {
    const fixture = tempCwd();
    try {
      const source = await recordInterrupted(fixture.cwd);
      for (const item of [
        { name: "timeout", script: workflow("timeoutMs: 100") },
        { name: "retries", script: workflow("retries: 1") },
      ]) {
        const result = await runWorkflow(item.script, {
          cwd: fixture.cwd,
          persistLogs: false,
          preparedContinuation: prepared(source.candidate),
          agent: continuedRunner(source.candidate),
        });
        assert.equal(result.result, "continued", item.name);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("compares format-1 continuation candidates with the legacy fingerprint", async () => {
    const fixture = tempCwd();
    const sourceScript = workflow("retries: 1, timeoutMs: null");
    try {
      const source = await recordInterrupted(fixture.cwd, sourceScript);
      const legacyCandidate: ContinuationCandidate = {
        ...source.candidate,
        inputsFormat: 1,
        inputsHash: legacyInputsHash(),
      };
      const continued = await runWorkflow(sourceScript, {
        cwd: fixture.cwd,
        persistLogs: false,
        preparedContinuation: prepared(legacyCandidate),
        agent: continuedRunner(legacyCandidate),
      });
      assert.equal(continued.result, "continued");

      const fallbacks: WorkflowRunFallback[] = [];
      const changed = await runWorkflow(
        workflow("retries: 1, timeoutMs: null, meta: { changed: true }"),
        {
          cwd: fixture.cwd,
          persistLogs: false,
          preparedContinuation: prepared(legacyCandidate),
          agent: {
            async run(_prompt, options) {
              assert.equal(options.continueFromSession, undefined);
              return "fresh";
            },
          },
          onFallback: (fallback) => fallbacks.push(fallback),
        },
      );
      assert.equal(changed.result, "fresh");
      assert.deepEqual(fallbacks[0]?.continuation, {
        outcome: "skipped",
        reason: "inputs-mismatch",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("surfaces runner skip reasons and synthesizes runner-declined", async () => {
    const fixture = tempCwd();
    try {
      const source = await recordInterrupted(fixture.cwd);
      const reasons = ["backend-mismatch", "capability-missing", "reattach-failed"] as const;
      for (const reason of reasons) {
        const fallbacks: WorkflowRunFallback[] = [];
        await runWorkflow(workflow(), {
          cwd: fixture.cwd,
          persistLogs: false,
          preparedContinuation: prepared(source.candidate),
          agent: continuedRunner(source.candidate, { reattached: false, reason }),
          onFallback: (fallback) => fallbacks.push(fallback),
        });
        assert.deepEqual(fallbacks[0]?.continuation, { outcome: "skipped", reason });
      }

      const declined: WorkflowRunFallback[] = [];
      await runWorkflow(workflow(), {
        cwd: fixture.cwd,
        persistLogs: false,
        preparedContinuation: prepared(source.candidate),
        agent: {
          async run(_prompt, options) {
            assert.ok(options.continueFromSession);
            return "fresh";
          },
        },
        onFallback: (fallback) => declined.push(fallback),
      });
      assert.deepEqual(declined[0]?.continuation, {
        outcome: "skipped",
        reason: "runner-declined",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("suppresses runner-outcome notices on caller cancellation while retaining engine-gate notices", async () => {
    const fixture = tempCwd();
    try {
      const source = await recordInterrupted(fixture.cwd);
      const controller = new AbortController();
      const fallbacks: WorkflowRunFallback[] = [];
      await assert.rejects(runWorkflow(workflow(), {
        cwd: fixture.cwd,
        persistLogs: false,
        signal: controller.signal,
        preparedContinuation: prepared(source.candidate),
        agent: {
          async run(_prompt, options) {
            assert.ok(options.continueFromSession);
            controller.abort();
            throw new Error("cancelled");
          },
        },
        onFallback: (fallback) => fallbacks.push(fallback),
      }));
      assert.deepEqual(fallbacks, []);

      const gateController = new AbortController();
      const gateFallbacks: WorkflowRunFallback[] = [];
      await assert.rejects(runWorkflow(workflow(), {
        cwd: fixture.cwd,
        persistLogs: false,
        signal: gateController.signal,
        preparedContinuation: prepared({ ...source.candidate, hash: "changed" }),
        agent: {
          async run() {
            gateController.abort();
            throw new Error("cancelled fresh call");
          },
        },
        onFallback: (fallback) => gateFallbacks.push(fallback),
      }));
      assert.deepEqual(gateFallbacks[0]?.continuation, {
        outcome: "skipped",
        reason: "hash-mismatch",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("reattaches only on attempt one; a fresh retry settles without a journal marker", async () => {
    const fixture = tempCwd();
    try {
      const retryScript = workflow("retries: 1");
      const source = await recordInterrupted(fixture.cwd, retryScript);
      const directives: Array<AgentSessionRecord | undefined> = [];
      const journal: JournalEntry[] = [];
      const fallbacks: WorkflowRunFallback[] = [];
      let attempt = 0;
      const result = await runWorkflow(retryScript, {
        cwd: fixture.cwd,
        persistLogs: false,
        preparedContinuation: prepared(source.candidate),
        agent: {
          async run(_prompt, options) {
            attempt += 1;
            directives.push(options.continueFromSession as AgentSessionRecord | undefined);
            if (attempt === 1) {
              options.onResultProvenance?.({
                source: "live",
                continuation: { reattached: true, method: "resume" },
              });
              throw new WorkflowError("retry", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
            }
            return "fresh retry";
          },
        },
        onFallback: (fallback) => fallbacks.push(fallback),
        onAgentJournal: (entry) => journal.push(entry),
      });
      assert.equal(result.result, "fresh retry");
      assert.deepEqual(directives.map(Boolean), [true, false]);
      assert.deepEqual(fallbacks.map((fallback) => fallback.continuation), [
        { outcome: "reattached", method: "resume" },
      ]);
      assert.equal(journal[0]?.call?.kind === "agent" ? journal[0].call.continuation : undefined, undefined);
    } finally {
      fixture.cleanup();
    }
  });

  it("runs a timed-out continuation only once and retries fresh without duplicating its notice", async () => {
    const fixture = tempCwd();
    try {
      const timedScript = workflow("retries: 1, timeoutMs: 10");
      const source = await recordInterrupted(fixture.cwd, timedScript);
      const directives: boolean[] = [];
      const fallbacks: WorkflowRunFallback[] = [];
      const journal: JournalEntry[] = [];
      let attempt = 0;
      const result = await runWorkflow(timedScript, {
        cwd: fixture.cwd,
        persistLogs: false,
        preparedContinuation: prepared(source.candidate),
        agent: {
          async run(_prompt, options) {
            attempt += 1;
            directives.push(options.continueFromSession !== undefined);
            if (attempt === 1) {
              options.onResultProvenance?.({
                source: "live",
                continuation: { reattached: true, method: "load" },
              });
              await new Promise<never>((_resolve, reject) => {
                options.signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
              });
            }
            return "fresh after timeout";
          },
        },
        onFallback: (fallback) => fallbacks.push(fallback),
        onAgentJournal: (entry) => journal.push(entry),
      });
      assert.equal(result.result, "fresh after timeout");
      assert.deepEqual(directives, [true, false]);
      assert.deepEqual(fallbacks.map((fallback) => fallback.continuation), [
        { outcome: "reattached", method: "load" },
      ]);
      assert.equal(journal[0]?.call?.kind === "agent" ? journal[0].call.continuation : undefined, undefined);
    } finally {
      fixture.cleanup();
    }
  });

  it("never threads a root continuation candidate into nested workflow execution", async () => {
    const fixture = tempCwd();
    try {
      const source = await recordInterrupted(fixture.cwd);
      const nested = `export const meta = { name: "parent", description: "nested continuation" }
return await workflow(\`export const meta = { name: "child", description: "child" }
return await agent("task", { label: "worker" })\`)`;
      const fallbacks: WorkflowRunFallback[] = [];
      const result = await runWorkflow(nested, {
        cwd: fixture.cwd,
        persistLogs: false,
        preparedContinuation: prepared(source.candidate),
        agent: {
          async run(_prompt, options) {
            assert.equal(options.continueFromSession, undefined);
            return "fresh nested result";
          },
        },
        onFallback: (fallback) => fallbacks.push(fallback),
      });
      assert.equal(result.result, "fresh nested result");
      assert.deepEqual(fallbacks, []);
    } finally {
      fixture.cleanup();
    }
  });

  it("pins identical-prompt continuation to the interrupted occurrence index", async () => {
    const fixture = tempCwd();
    const script = workflow("", `
const first = await agent('same', { label: 'same' })
const second = await agent('same', { label: 'same' })
return [first, second]`);
    try {
      const calls: WorkflowCallRecord[] = [];
      let interruptedSession: AgentSessionRecord | undefined;
      let sourceCall = 0;
      await assert.rejects(runWorkflow(script, {
        cwd: fixture.cwd,
        persistLogs: false,
        agent: {
          async run(_prompt, options) {
            sourceCall += 1;
            options.onSessionOpen?.({
              sessionId: `same-${sourceCall}`,
              backendId: "test-backend",
              poolKey: "test-backend",
              cwd: fixture.cwd,
              reopen: { load: true, resume: true, list: true },
            });
            if (sourceCall === 2) {
              throw new WorkflowError("pause", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
            }
            return "first";
          },
        },
        onCallRecord: (call) => calls.push(call),
        onAgentEnd: (event) => {
          if (event.callIndex === 1) interruptedSession = event.session;
        },
      }));
      assert.ok(interruptedSession);
      const interrupted = calls.find((call) => call.index === 1) as WorkflowCallRecord;
      const candidate: ContinuationCandidate = {
        callIndex: 1,
        hash: interrupted.hash,
        inputsHash: interrupted.inputsHash,
        sessionRef: interruptedSession,
        recordedCwd: interrupted.resolvedCwd ?? fixture.cwd,
      };
      const directives: Array<[number | undefined, boolean]> = [];
      const result = await runWorkflow(script, {
        cwd: fixture.cwd,
        persistLogs: false,
        preparedContinuation: prepared(candidate),
        agent: {
          async run(_prompt, options) {
            directives.push([options.callIndex, options.continueFromSession !== undefined]);
            if (options.continueFromSession) {
              options.onResultProvenance?.({
                source: "live",
                continuation: { reattached: true, method: "resume" },
              });
            }
            return options.continueFromSession ? "continued second" : "fresh first";
          },
        },
      });
      assert.deepEqual(directives, [[0, false], [1, true]]);
      assert.equal(JSON.stringify(result.result), JSON.stringify(["fresh first", "continued second"]));
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves a continuation marker through prepared replay and remains strategy-independent", async () => {
    const fixture = tempCwd();
    try {
      const source = await recordInterrupted(fixture.cwd);
      const continuedJournal: JournalEntry[] = [];
      await runWorkflow(workflow(), {
        cwd: fixture.cwd,
        persistLogs: false,
        preparedContinuation: prepared(source.candidate),
        agent: continuedRunner(source.candidate),
        onAgentJournal: (entry) => continuedJournal.push(entry),
      });
      const replayedJournal: JournalEntry[] = [];
      const positional: PreparedResume = {
        strategy: "positional-v1",
        sourceRunId: "continued-source",
        requestedPolicy: "positional",
        fallbackReason: "forced-positional",
        eligibility: "legacy",
        sourceCalls: new Map(),
      };
      await runWorkflow(workflow(), {
        cwd: fixture.cwd,
        persistLogs: false,
        agent: { async run() { throw new Error("must replay"); } },
        preparedResume: positional,
        resumeJournal: new Map([[0, continuedJournal[0] as JournalEntry]]),
        onAgentJournal: (entry) => replayedJournal.push(entry),
      });
      assert.deepEqual(
        replayedJournal[0]?.call?.kind === "agent" ? replayedJournal[0].call.continuation : undefined,
        { method: "resume" },
      );

      let liveStrategyDirective = false;
      await runWorkflow(workflow(), {
        cwd: fixture.cwd,
        persistLogs: false,
        preparedContinuation: prepared(source.candidate),
        preparedResume: {
          strategy: "live",
          sourceRunId: "paused-source",
          requestedPolicy: "auto",
          disabledReason: "resume-metadata-missing",
        },
        agent: {
          async run(_prompt, options) {
            liveStrategyDirective = options.continueFromSession !== undefined;
            options.onResultProvenance?.({
              source: "live",
              continuation: { reattached: true, method: "resume" },
            });
            return "continued despite live strategy";
          },
        },
      });
      assert.equal(liveStrategyDirective, true);
    } finally {
      fixture.cleanup();
    }
  });
});
