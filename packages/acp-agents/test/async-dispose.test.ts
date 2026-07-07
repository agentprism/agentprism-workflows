import test from "node:test";
import assert from "node:assert/strict";
import { AcpAgentRunner } from "../src/index.js";

class TestRunner extends AcpAgentRunner {
  disposed = false;

  override async dispose(): Promise<void> {
    this.disposed = true;
    await super.dispose();
  }
}

test("AcpAgentRunner supports await using via Symbol.asyncDispose", async () => {
  let runner: TestRunner | undefined;

  {
    await using scoped = new TestRunner();
    runner = scoped;
    assert.equal(runner.disposed, false);
  }

  assert.equal(runner.disposed, true);
});
