// Pure prompt-content adaptation: ACP PromptCapabilities gate optional ContentBlocks, while
// baseline text/resource_link pass through untouched.
import test from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { adaptPromptContent } from "../src/index.js";

test("adaptPromptContent: keeps image blocks unchanged when promptCapabilities.image is true", () => {
  const blocks: ContentBlock[] = [
    { type: "text", text: "see attached" },
    { type: "image", data: "ZmFrZQ==", mimeType: "image/png", uri: "file:///tmp/a.png" },
  ];

  const out = adaptPromptContent(blocks, { promptCapabilities: { image: true } }, "codex");

  assert.equal(out, blocks, "no adaptation => same array reference");
  assert.deepEqual(out, blocks);
});

test("adaptPromptContent: degrades image blocks when promptCapabilities.image is absent or false", () => {
  const absent = adaptPromptContent(
    [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
    {},
    "claude",
  );
  assert.deepEqual(absent, [
    {
      type: "text",
      text: "[image omitted: image/png — the claude agent does not advertise promptCapabilities.image]",
    },
  ]);

  const unsupported = adaptPromptContent(
    [{ type: "image", data: "ZmFrZQ==", mimeType: "image/jpeg", uri: "file:///tmp/photo.jpg" }],
    { promptCapabilities: { image: false } },
    "codex",
  );
  assert.deepEqual(unsupported, [
    {
      type: "text",
      text: "[image omitted: image/jpeg; uri=file:///tmp/photo.jpg — the codex agent does not advertise promptCapabilities.image]",
    },
  ]);
});

test("adaptPromptContent: returns the same array reference when there are no optional blocks", () => {
  const blocks: ContentBlock[] = [
    { type: "text", text: "read this" },
    { type: "resource_link", name: "notes", uri: "file:///tmp/notes.md" },
  ];

  assert.equal(adaptPromptContent(blocks, {}, "custom"), blocks);
});

test("adaptPromptContent: returns the same array reference when all optional blocks are supported", () => {
  const blocks: ContentBlock[] = [
    { type: "text", text: "before" },
    { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
    { type: "audio", data: "ZmFrZQ==", mimeType: "audio/wav" },
    { type: "resource", resource: { uri: "file:///tmp/context.txt", text: "context" } },
  ];

  assert.equal(
    adaptPromptContent(
      blocks,
      { promptCapabilities: { image: true, audio: true, embeddedContext: true } },
      "custom",
    ),
    blocks,
  );
});

test("adaptPromptContent: degrades audio blocks when promptCapabilities.audio is absent or false", () => {
  const absent = adaptPromptContent([{ type: "audio", data: "ZmFrZQ==", mimeType: "audio/wav" }], {}, "claude");
  assert.deepEqual(absent, [
    {
      type: "text",
      text: "[audio omitted: audio/wav — the claude agent does not advertise promptCapabilities.audio]",
    },
  ]);

  const unsupported = adaptPromptContent(
    [{ type: "audio", data: "ZmFrZQ==", mimeType: "audio/ogg" }],
    { promptCapabilities: { audio: false } },
    "browser",
  );
  assert.deepEqual(unsupported, [
    {
      type: "text",
      text: "[audio omitted: audio/ogg — the browser agent does not advertise promptCapabilities.audio]",
    },
  ]);

  const supported: ContentBlock[] = [{ type: "audio", data: "ZmFrZQ==", mimeType: "audio/mpeg" }];
  assert.equal(adaptPromptContent(supported, { promptCapabilities: { audio: true } }, "codex"), supported);
});

test("adaptPromptContent: degrades resource blocks when embedded context is absent", () => {
  const out = adaptPromptContent(
    [{ type: "resource", resource: { uri: "file:///tmp/context.txt", text: "context" } }],
    {},
    "browser",
  );

  assert.deepEqual(out, [
    {
      type: "text",
      text: "[resource omitted: uri=file:///tmp/context.txt — the browser agent does not advertise promptCapabilities.embeddedContext]",
    },
  ]);
});

test("adaptPromptContent: never mutates the input and leaves supported optional blocks untouched", () => {
  const text: ContentBlock = { type: "text", text: "before" };
  const audio: ContentBlock = { type: "audio", data: "ZmFrZQ==", mimeType: "audio/wav" };
  const resource: ContentBlock = {
    type: "resource",
    resource: { uri: "file:///tmp/context.txt", text: "context", mimeType: "text/plain" },
  };
  const blocks: ContentBlock[] = [
    text,
    { type: "image", data: "ZmFrZQ==", mimeType: "image/gif", uri: null },
    audio,
    resource,
  ];
  const snapshot = structuredClone(blocks);

  const out = adaptPromptContent(
    blocks,
    { promptCapabilities: { image: false, audio: true, embeddedContext: true } },
    "browser",
  );

  assert.notEqual(out, blocks, "a degraded image allocates a new array");
  assert.deepEqual(blocks, snapshot, "input array and blocks are untouched");
  assert.equal(out[0], text);
  assert.deepEqual(out[1], {
    type: "text",
    text: "[image omitted: image/gif — the browser agent does not advertise promptCapabilities.image]",
  });
  assert.equal(out[2], audio);
  assert.equal(out[3], resource);
});
