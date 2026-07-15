import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentResult, AgentRunner, RunOptions } from "@automatalabs/shared-types";
import type { TSchema } from "typebox";
import {
  CALL_PATH_FORMAT,
  CALL_PATH_RAW_FRAMES,
  runWorkflow,
  sanitizeVmName,
} from "../src/workflow.js";

async function pathsFor(body: string, meta = "{ name: 'path', description: 'call path' }"): Promise<Array<string | undefined>> {
  const paths: Array<string | undefined> = [];
  const runner: AgentRunner = {
    async run<S extends TSchema | undefined = undefined>(
      _prompt: string,
      options?: RunOptions<S>,
    ): Promise<AgentResult<S>> {
      paths.push(options?.callPath);
      return "ok" as AgentResult<S>;
    },
  };
  await runWorkflow(`export const meta = ${meta}\n${body}`, { agent: runner, persistLogs: false });
  return paths;
}

describe("workflow call paths", () => {
  it("normalizes to body-relative coordinates independent of meta formatting", async () => {
    const body = `await Promise.resolve()
return await agent('direct', { label: 'direct' })`;
    const compact = await pathsFor(body);
    const multiline = await pathsFor(
      body,
      `{
  name: 'path',
  description: 'call path',
  phases: [{ title: 'Only' }],
}`,
    );

    assert.deepEqual(compact, ["3:14"]);
    assert.deepEqual(multiline, compact);
  });

  it("captures the contiguous synchronous helper chain innermost-first", async () => {
    const paths = await pathsFor(`await Promise.resolve()
function helper(){ return agent('inside-helper') }
return await helper()`);

    assert.deepEqual(paths, ["3:27<4:14"]);
  });

  it("stops at an awaiting helper's adjacent async frame", async () => {
    const paths = await pathsFor(`async function helper(){ await Promise.resolve(); return agent('after-await') }
return await helper()`);

    assert.deepEqual(paths, ["2:58"]);
  });

  it("returns no path when more than the raw-frame limit may exist", async () => {
    const paths = await pathsFor(`await Promise.resolve()
function descend(n){ return n === 0 ? agent('deep') : descend(n - 1) }
return await descend(${CALL_PATH_RAW_FRAMES + 8})`);

    assert.deepEqual(paths, [undefined]);
  });

  it("uses one structural path for loop occurrences and mapped thunks", async () => {
    const loopPaths = await pathsFor(`await Promise.resolve()
const results = []
for (let i = 0; i < 3; i++) results.push(await agent('loop-' + i))
return results`);
    const mappedPaths = await pathsFor(`await Promise.resolve()
return await parallel([1, 2, 3].map((value) => () => agent('map-' + value)))`);

    assert.equal(new Set(loopPaths).size, 1);
    assert.equal(new Set(mappedPaths).size, 1);
    assert.equal(loopPaths.length, 3);
    assert.equal(mappedPaths.length, 3);
  });

  it("records aliased agent invocations by call site", async () => {
    const paths = await pathsFor(`await Promise.resolve()
const invoke = agent
const first = await invoke('first')
const second = await invoke('second')
return { first, second }`);

    assert.equal(paths.length, 2);
    assert.notEqual(paths[0], paths[1]);
    assert.deepEqual(paths, ["4:21", "5:22"]);
  });

  it("sanitizes vm names and truncates the sanitized base to 64 characters", async () => {
    assert.equal(sanitizeVmName("team/review workflow"), "team-review-workflow");
    assert.equal(sanitizeVmName(""), "workflow");
    assert.equal(sanitizeVmName("x".repeat(80)), "x".repeat(64));

    const result = await runWorkflow(
      `export const meta = { name: '../unsafe/name', description: 'safe stack filename' }
return new Error('marker').stack`,
      {
        agent: {
          async run() {
            return "unused";
          },
        },
        persistLogs: false,
      },
    );
    assert.match(String(result.result), /\.\.-unsafe-name\.js/);
    assert.doesNotMatch(String(result.result), /\.\.\/unsafe\/name/);
  });

  it("pins the observable call-path format and restores Error stack globals", async () => {
    assert.equal(CALL_PATH_FORMAT, 1);
    assert.equal(CALL_PATH_RAW_FRAMES, 64);
    const originalPrepareStackTrace = Error.prepareStackTrace;
    const originalStackTraceLimit = Error.stackTraceLimit;

    await pathsFor(`await Promise.resolve()
return await agent('restore')`);

    assert.equal(Error.prepareStackTrace, originalPrepareStackTrace);
    assert.equal(Error.stackTraceLimit, originalStackTraceLimit);
  });
});
