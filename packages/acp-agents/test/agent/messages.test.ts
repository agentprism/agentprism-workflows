// The message-level fold (src/agent/messages.ts) with synthetic update records — no fake agent.
// Pins the assistant-message boundary (the `text` fold's: tool/thought/plan/user events and a
// changed `messageId`), tool-call attachment and the by-id fold, the leading-thought rule, user
// runs, turn boundaries with and without retention, and the copy contract. The invariant against
// the REAL accumulator (`turn.text` === the text-bearing messages joined) lives in
// acp-agent.test.ts, where the fake agent drives `SessionState`.
import test from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpSessionUpdate } from "../../src/events.js";
import { MessageFolder, foldMessages, foldToolCall } from "../../src/agent/messages.js";
import type { AcpAgentMessage, AcpAgentUpdateRecord } from "../../src/agent/types.js";

const text = (t: string): ContentBlock => ({ type: "text", text: t });
const chunk = (t: string, messageId?: string): AcpSessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: text(t),
  ...(messageId !== undefined ? { messageId } : {}),
});
const thought = (t: string): AcpSessionUpdate => ({ sessionUpdate: "agent_thought_chunk", content: text(t) });
const user = (t: string): AcpSessionUpdate => ({ sessionUpdate: "user_message_chunk", content: text(t) });
const toolCall = (id: string, title = id): AcpSessionUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title,
  kind: "read",
  status: "in_progress",
});
const toolUpdate = (id: string, extra: Record<string, unknown> = {}): AcpSessionUpdate =>
  ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", ...extra }) as AcpSessionUpdate;
const usage: AcpSessionUpdate = { sessionUpdate: "usage_update", used: 1, size: 10 };
const image: ContentBlock = { type: "image", data: "AAAA", mimeType: "image/png" };

/** Fold `updates` with ascending `receivedAt`s starting at `t0`. */
function fold(updates: readonly AcpSessionUpdate[], t0 = 100): AcpAgentMessage[] {
  const records: AcpAgentUpdateRecord[] = updates.map((update, index) => ({ update, receivedAt: t0 + index }));
  return foldMessages(records);
}
const textOf = (message: AcpAgentMessage): string =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
const shape = (messages: readonly AcpAgentMessage[]) =>
  messages.map((message) => ({
    role: message.role,
    text: textOf(message),
    blocks: message.content.map((block) => block.type),
    tools: message.toolCalls.map((call) => `${call.toolCallId}:${call.status}`),
    thoughts: message.thoughts.map((block) => (block.type === "text" ? block.text : block.type)),
  }));

test("assistant messages split where the text fold splits: tool calls, thoughts, plans, user chunks", () => {
  const messages = fold([
    thought("think "),
    thought("first"),
    chunk("A1"),
    chunk("A2"),
    toolCall("tc-1", "Read"),
    toolUpdate("tc-1", { rawOutput: "x" }),
    thought("then"),
    chunk("B"),
    toolUpdate("tc-2", { title: "Bare" }),
    chunk("C"),
    { sessionUpdate: "plan", entries: [] },
    chunk("D"),
    usage,
    chunk("D2"),
    user("steer"),
    chunk("E"),
  ]);
  assert.deepEqual(shape(messages), [
    { role: "assistant", text: "A1A2", blocks: ["text"], tools: ["tc-1:completed"], thoughts: ["think first"] },
    { role: "assistant", text: "B", blocks: ["text"], tools: ["tc-2:completed"], thoughts: ["then"] },
    { role: "assistant", text: "C", blocks: ["text"], tools: [], thoughts: [] },
    { role: "assistant", text: "DD2", blocks: ["text"], tools: [], thoughts: [] },
    { role: "user", text: "steer", blocks: ["text"], tools: [], thoughts: [] },
    { role: "assistant", text: "E", blocks: ["text"], tools: [], thoughts: [] },
  ]);
  // The invariant the fold guarantees: the text-bearing assistant messages joined by a blank line
  // are the whole-turn text fold (`SessionState.foldedTurnText()`): one message per boundary.
  assert.equal(
    messages.filter((m) => m.role === "assistant").map(textOf).join("\n\n"),
    "A1A2\n\nB\n\nC\n\nDD2\n\nE",
  );
  // A tool_call_update for a known id updated the call where it lives; the bare update created one.
  assert.deepEqual(messages[0]!.toolCalls, [
    { toolCallId: "tc-1", title: "Read", kind: "read", status: "completed", rawOutput: "x" },
  ]);
  assert.deepEqual(messages[1]!.toolCalls, [{ toolCallId: "tc-2", title: "Bare", status: "completed" }]);
  // receivedAt is the FIRST update folded into the message — the leading thought's, here.
  assert.equal(messages[0]!.receivedAt, 100);
  assert.equal(messages[1]!.receivedAt, 106, "the thought at index 6 leads message B");
  assert.equal(messages[4]!.receivedAt, 114);
});

test("a changed ACP messageId is a boundary; the same id or no id concatenates", () => {
  assert.deepEqual(shape(fold([chunk("a", "m1"), chunk("b", "m1"), chunk("c", "m2"), chunk("d"), chunk("e", "m3")])), [
    { role: "assistant", text: "ab", blocks: ["text"], tools: [], thoughts: [] },
    { role: "assistant", text: "cd", blocks: ["text"], tools: [], thoughts: [] },
    { role: "assistant", text: "e", blocks: ["text"], tools: [], thoughts: [] },
  ]);
  // A boundary event forgets the active id (SessionState.markAssistantMessageBoundary), so the
  // same id after a tool call is still a new message — exactly the text fold.
  assert.deepEqual(shape(fold([chunk("a", "m1"), toolCall("tc"), chunk("b", "m1")])).map((m) => m.text), ["a", "b"]);
});

test("a turn that starts with a tool call has a leading assistant message with no text; text after it is new", () => {
  const messages = fold([toolCall("tc-1"), chunk("A"), toolCall("tc-2"), chunk("B")]);
  assert.deepEqual(shape(messages), [
    { role: "assistant", text: "", blocks: [], tools: ["tc-1:in_progress"], thoughts: [] },
    { role: "assistant", text: "A", blocks: ["text"], tools: ["tc-2:in_progress"], thoughts: [] },
    { role: "assistant", text: "B", blocks: ["text"], tools: [], thoughts: [] },
  ]);
  // Only the text-bearing messages take part in the text fold: no leading blank line.
  const textBearing = messages.filter((m) => m.role === "assistant" && m.content.some((b) => b.type === "text"));
  assert.equal(textBearing.map(textOf).join("\n\n"), "A\n\nB");
});

test("thoughts lead: they attach to the assistant content that follows; a trailing or pre-user thought stands alone", () => {
  // Codex shape: reasoning, tool call (no text), reasoning, message.
  assert.deepEqual(shape(fold([thought("r1"), toolCall("tc-1"), toolUpdate("tc-1"), thought("r2"), chunk("A")])), [
    { role: "assistant", text: "", blocks: [], tools: ["tc-1:completed"], thoughts: ["r1"] },
    { role: "assistant", text: "A", blocks: ["text"], tools: [], thoughts: ["r2"] },
  ]);
  // A thought before a user message is its own message, in order; a trailing thought too.
  assert.deepEqual(shape(fold([chunk("A"), thought("hmm"), user("u"), chunk("B"), thought("tail")])), [
    { role: "assistant", text: "A", blocks: ["text"], tools: [], thoughts: [] },
    { role: "assistant", text: "", blocks: [], tools: [], thoughts: ["hmm"] },
    { role: "user", text: "u", blocks: ["text"], tools: [], thoughts: [] },
    { role: "assistant", text: "B", blocks: ["text"], tools: [], thoughts: [] },
    { role: "assistant", text: "", blocks: [], tools: [], thoughts: ["tail"] },
  ]);
  // A thought after text and before a tool call goes with the message the tool call attaches to.
  assert.deepEqual(shape(fold([chunk("A"), thought("t"), toolCall("tc"), chunk("B")])), [
    { role: "assistant", text: "A", blocks: ["text"], tools: ["tc:in_progress"], thoughts: ["t"] },
    { role: "assistant", text: "B", blocks: ["text"], tools: [], thoughts: [] },
  ]);
});

test("non-text assistant blocks attach in order; with a pending boundary they open the message the next text joins", () => {
  const imageChunk: AcpSessionUpdate = { sessionUpdate: "agent_message_chunk", content: image };
  assert.deepEqual(shape(fold([chunk("A"), imageChunk, chunk("B"), toolCall("tc"), imageChunk, chunk("C")])), [
    { role: "assistant", text: "AB", blocks: ["text", "image", "text"], tools: ["tc:in_progress"], thoughts: [] },
    { role: "assistant", text: "C", blocks: ["image", "text"], tools: [], thoughts: [] },
  ]);
  assert.deepEqual(shape(fold([imageChunk, chunk("A")])), [
    { role: "assistant", text: "A", blocks: ["image", "text"], tools: [], thoughts: [] },
  ]);
});

test("a run of user chunks is one user message; bookkeeping never breaks a run or a message", () => {
  assert.deepEqual(shape(fold([user("ab"), usage, user("cd"), chunk("x"), usage, chunk("y"), user("z")])), [
    { role: "user", text: "abcd", blocks: ["text"], tools: [], thoughts: [] },
    { role: "assistant", text: "xy", blocks: ["text"], tools: [], thoughts: [] },
    { role: "user", text: "z", blocks: ["text"], tools: [], thoughts: [] },
  ]);
});

test("text chunks fold into one block keeping the first chunk's fields; other blocks are copied as sent", () => {
  const [message] = fold([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a", _meta: { first: true } } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b", _meta: { second: true } } },
  ]);
  assert.deepEqual(message!.content, [{ type: "text", text: "ab", _meta: { first: true } }]);
});

test("beginTurn marks a boundary and closes the message in progress; without retention it clears the transcript", () => {
  const folder = new MessageFolder();
  folder.apply(chunk("A"), 1);
  folder.apply(toolCall("tc-1"), 2);
  folder.apply(thought("tail"), 3);
  assert.deepEqual(shape(folder.snapshot()).map((m) => [m.text, m.tools, m.thoughts]), [
    ["A", ["tc-1:in_progress"], []],
    ["", [], ["tail"]],
  ]);

  folder.beginTurn(true);
  // The next turn's tool call opens a NEW message rather than attaching to the previous turn's;
  // the flushed trailing thought is a message of its own and never an attach target.
  folder.apply(toolCall("tc-2"), 4);
  folder.apply(chunk("B"), 5);
  // A tool_call_update for the earlier turn's id still updates that call where it lives.
  folder.apply(toolUpdate("tc-1"), 6);
  assert.deepEqual(shape(folder.snapshot()).map((m) => [m.text, m.tools, m.thoughts]), [
    ["A", ["tc-1:completed"], []],
    ["", [], ["tail"]],
    ["", ["tc-2:in_progress"], []],
    ["B", [], []],
  ]);
  assert.deepEqual(folder.toolCalls.map((call) => call.toolCallId), ["tc-1", "tc-2"], "first-seen order, flattened");

  folder.beginTurn(false);
  assert.deepEqual(folder.snapshot(), [], "retainHistory:false clears like the accumulator");
  folder.apply(toolUpdate("tc-1", { title: "again" }), 7);
  assert.deepEqual(shape(folder.snapshot()), [
    { role: "assistant", text: "", blocks: [], tools: ["tc-1:completed"], thoughts: [] },
  ]);
  assert.equal(folder.toolCalls[0]!.title, "again", "a cleared transcript forgets old ids: a bare entry again");
});

test("snapshots and toolCalls hand out copies; foldToolCall merges fields and _meta", () => {
  const folder = new MessageFolder();
  folder.apply(chunk("A"), 1);
  folder.apply({ ...toolCall("tc-1", "Read"), _meta: { a: 1 } } as AcpSessionUpdate, 2);
  const first = folder.snapshot();
  (first[0]!.content[0] as { text: string }).text = "mutated";
  (first[0]!.toolCalls[0] as { title: string }).title = "mutated";
  assert.equal(textOf(folder.snapshot()[0]!), "A");
  assert.equal(folder.toolCalls[0]!.title, "Read");

  const entry = foldToolCall(undefined, toolCall("tc-9", "Nine") as Extract<AcpSessionUpdate, { sessionUpdate: "tool_call" }>);
  foldToolCall(entry, toolUpdate("tc-9", { rawOutput: "out", _meta: { b: 2 } }) as Extract<AcpSessionUpdate, { sessionUpdate: "tool_call_update" }>);
  foldToolCall(entry, toolUpdate("tc-9", { _meta: { c: 3 } }) as Extract<AcpSessionUpdate, { sessionUpdate: "tool_call_update" }>);
  assert.deepEqual(entry, { toolCallId: "tc-9", title: "Nine", kind: "read", status: "completed", rawOutput: "out", meta: { b: 2, c: 3 } });
});
