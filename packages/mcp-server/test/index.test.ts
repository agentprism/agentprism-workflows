import test from "node:test";
import assert from "node:assert/strict";

// Same-package unit test: relative ../src import. The composition-root entry is import-safe
// (it only starts the stdio server when run as the process entry point).
import {
  createWorkflowServer,
  EVENTS_RESOURCE_MIME_TYPE,
  WORKFLOW_RUN_EVENTS_SCHEMA_VERSION,
  parseWorkflowRunEventsUri,
  workflowRunEventsUri,
} from "../src/index.js";

test("@automatalabs/mcp-server public entry is reachable via ../src", () => {
  assert.equal(typeof createWorkflowServer, "function");
  assert.equal(EVENTS_RESOURCE_MIME_TYPE, "application/json");
  assert.equal(WORKFLOW_RUN_EVENTS_SCHEMA_VERSION, 1);
  assert.equal(workflowRunEventsUri("run-one"), "workflow://runs/run-one/events");
  assert.equal(parseWorkflowRunEventsUri("workflow://runs/run-one/events")?.canonical, true);
});
