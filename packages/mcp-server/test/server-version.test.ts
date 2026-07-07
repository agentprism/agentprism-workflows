import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { connect, okRunner } from "./_harness.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

test("initialize response reports the package version", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    assert.equal(client.getServerVersion()?.version, version);
  } finally {
    await dispose();
  }
});
