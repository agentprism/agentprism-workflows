// The message-level fold of an ACP session/update stream: the per-turn `turn.messages` and the
// agent-wide `agent.messages` transcript are both this folder, fed the same verbatim update
// records the collector keeps. It also owns the tool-call fold (`tool_call` ⊕ `tool_call_update`
// by id) so the turn-level `toolCalls` and each message's `toolCalls` are one fold, never two.
//
// The assistant-message boundary is EXACTLY the one `SessionState.foldedTurnText()` uses for
// `turn.text` / `agent.text` (acp-client.ts): text chunks concatenate into one message until a
// content event that is not an assistant message chunk — `tool_call`, `tool_call_update`,
// `agent_thought_chunk`, `plan`, `plan_update`, `plan_removed`, `user_message_chunk` — or a changed
// ACP `messageId` marks a boundary; the next text chunk then opens a new assistant message.
// Bookkeeping updates (usage, mode, commands, config, session info) never break a message. The
// invariant that follows: `turn.text` equals the text-bearing assistant messages of the turn
// joined by "\n\n".
//
// What the text fold does not track is placed like this:
//   - Tool calls attach to the assistant message in progress, opening one when none is (so a turn
//     that starts with a tool call has a leading assistant message with no text). A
//     `tool_call_update` for a known id updates that call where it lives.
//   - Thoughts LEAD: every installed adapter streams reasoning before the text or tool call it
//     produced, so `agent_thought_chunk`s are held and attached to the assistant message that
//     receives the next assistant content (a text chunk, a tool call, a non-text block). A thought
//     followed by a user message or by the end of the turn becomes an assistant message of its own.
//   - Non-text assistant blocks (image, audio, resource, resource_link) attach to the message in
//     progress and open one when a boundary is pending.
//   - A run of `user_message_chunk`s is one user message; any content update ends the run.
// Consecutive text chunks of one message (or thought) fold into one text block: the first chunk's
// fields, the concatenated text. The verbatim chunks stay in `turn.updates`.
import type { ContentBlock, ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk";
import type { AcpSessionUpdate } from "../events.js";
import type { AcpAgentMessage, AcpAgentToolCall, AcpAgentUpdateRecord } from "./types.js";

export interface MutableToolCall {
  toolCallId: string;
  name?: string;
  title: string;
  kind?: ToolKind;
  status: ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  meta?: Record<string, unknown>;
}

type ToolCallUpdate = Extract<AcpSessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;

interface MutableMessage {
  readonly role: "user" | "assistant";
  content: ContentBlock[];
  readonly toolCalls: MutableToolCall[];
  readonly thoughts: ContentBlock[];
  readonly receivedAt: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Fold one `tool_call` / `tool_call_update` into `existing` (a fresh entry when undefined):
 *  every field the update carries replaces the last seen one, `_meta` merges shallowly, and
 *  `status` stays `pending` until the agent sends one. */
export function foldToolCall(existing: MutableToolCall | undefined, update: ToolCallUpdate): MutableToolCall {
  const meta = record(update._meta);
  const entry: MutableToolCall = existing ?? {
    toolCallId: update.toolCallId,
    title: typeof update.title === "string" ? update.title : "",
    status: "pending",
  };
  if (typeof update.title === "string") entry.title = update.title;
  if (typeof update.name === "string") entry.name = update.name;
  if (update.kind !== undefined && update.kind !== null) entry.kind = update.kind;
  if (update.status !== undefined && update.status !== null) entry.status = update.status;
  if (update.rawInput !== undefined) entry.rawInput = update.rawInput;
  if (update.rawOutput !== undefined) entry.rawOutput = update.rawOutput;
  if (update.content !== undefined && update.content !== null) entry.content = update.content;
  if (update.locations !== undefined && update.locations !== null) entry.locations = update.locations;
  if (meta) entry.meta = { ...(entry.meta ?? {}), ...meta };
  return entry;
}

/** Append `block` to `blocks`, concatenating a text block onto a trailing text block. */
function appendBlock(blocks: ContentBlock[], block: ContentBlock): void {
  const last = blocks[blocks.length - 1];
  if (block.type === "text" && last?.type === "text") {
    blocks[blocks.length - 1] = { ...last, text: last.text + block.text };
    return;
  }
  blocks.push({ ...block });
}

/** A fresh, shallow copy of a message (blocks and tool calls copied one level deep). */
export function copyMessage(message: AcpAgentMessage): AcpAgentMessage {
  return {
    role: message.role,
    content: message.content.map((block) => ({ ...block })),
    toolCalls: message.toolCalls.map((call) => ({ ...call })),
    thoughts: message.thoughts.map((block) => ({ ...block })),
    receivedAt: message.receivedAt,
  };
}

export class MessageFolder {
  readonly #messages: MutableMessage[] = [];
  /** The assistant message tool calls and non-text blocks attach to; unset after a user message or
   *  a turn boundary. */
  #assistant: MutableMessage | undefined;
  /** The open run of `user_message_chunk`s. */
  #user: MutableMessage | undefined;
  /** Thoughts waiting for the assistant content they precede. */
  #pendingThoughts: ContentBlock[] = [];
  #pendingThoughtsAt: number | undefined;
  /** `SessionState.assistantMessageBoundaryPending`: the next text chunk opens a new message. */
  #boundaryPending = true;
  /** `SessionState.activeAssistantMessageId`: a changed ACP `messageId` is a boundary. */
  #activeMessageId: string | undefined;
  readonly #toolCallsById = new Map<string, MutableToolCall>();

  /** Mirror `SessionState.beginTurn()`: a boundary, no message in progress, and — like the
   *  accumulator under `retainSessionLog: false` — a cleared transcript when `retain` is false.
   *  A thought left over from the previous turn becomes its own assistant message first. */
  beginTurn(retain: boolean): void {
    if (retain) {
      this.#flushPendingThoughts();
    } else {
      this.#messages.length = 0;
      this.#toolCallsById.clear();
      this.#pendingThoughts = [];
      this.#pendingThoughtsAt = undefined;
    }
    this.#assistant = undefined;
    this.#user = undefined;
    this.#markBoundary();
  }

  apply(update: AcpSessionUpdate, receivedAt: number): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        this.#user = undefined;
        this.#applyMessageId(update.messageId);
        // A pending boundary opens a new message for ANY block. The text fold consumes it only on
        // a text chunk, but a non-text block consuming it here never moves a text chunk between
        // messages: the message it opens holds no earlier text, so the next text chunk is its
        // first either way.
        const target =
          this.#boundaryPending || !this.#assistant ? this.#openAssistant(receivedAt) : this.#assistant;
        this.#boundaryPending = false;
        appendBlock(target.content, update.content);
        return;
      }
      case "agent_thought_chunk": {
        this.#user = undefined;
        this.#markBoundary();
        appendBlock(this.#pendingThoughts, update.content);
        this.#pendingThoughtsAt ??= receivedAt;
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        this.#user = undefined;
        this.#markBoundary();
        const existing = this.#toolCallsById.get(update.toolCallId);
        if (existing) {
          foldToolCall(existing, update);
          return;
        }
        const target = this.#assistant ?? this.#openAssistant(receivedAt);
        this.#adoptPendingThoughts(target);
        const entry = foldToolCall(undefined, update);
        target.toolCalls.push(entry);
        this.#toolCallsById.set(entry.toolCallId, entry);
        return;
      }
      case "user_message_chunk": {
        this.#markBoundary();
        this.#assistant = undefined;
        this.#flushPendingThoughts();
        if (!this.#user) {
          this.#user = { role: "user", content: [], toolCalls: [], thoughts: [], receivedAt };
          this.#messages.push(this.#user);
        }
        appendBlock(this.#user.content, update.content);
        return;
      }
      case "plan":
      case "plan_update":
      case "plan_removed": {
        this.#user = undefined;
        this.#markBoundary();
        return;
      }
      default:
        return;
    }
  }

  /** Every folded tool call in first-seen order (copies) — the flattening of the messages'
   *  `toolCalls`, which is the same order because a call attaches to the message in progress. */
  get toolCalls(): AcpAgentToolCall[] {
    return this.#messages.flatMap((message) => message.toolCalls.map((call) => ({ ...call })));
  }

  /** The messages so far (copies). A thought still waiting for the content it precedes is
   *  reported as a trailing assistant message with no text. */
  snapshot(): AcpAgentMessage[] {
    const messages = this.#messages.map(copyMessage);
    if (this.#pendingThoughts.length > 0) {
      messages.push({
        role: "assistant",
        content: [],
        toolCalls: [],
        thoughts: this.#pendingThoughts.map((block) => ({ ...block })),
        receivedAt: this.#pendingThoughtsAt!,
      });
    }
    return messages;
  }

  #markBoundary(): void {
    this.#boundaryPending = true;
    this.#activeMessageId = undefined;
  }

  /** `SessionState.beginAssistantMessageChunk`'s id rule: a chunk whose `messageId` differs from
   *  the active one marks a boundary; an id is remembered whether or not the chunk carries text. */
  #applyMessageId(messageId: string | null | undefined): void {
    const id = messageId ?? undefined;
    if (id !== undefined && this.#activeMessageId !== undefined && id !== this.#activeMessageId) {
      this.#boundaryPending = true;
    }
    if (id !== undefined) this.#activeMessageId = id;
  }

  /** Open a new assistant message (adopting any pending thoughts, which then date it). The
   *  boundary flag is the caller's: a text or non-text block consumes it, a tool call does not
   *  (text after a tool call is always a new message, exactly like the text fold). */
  #openAssistant(receivedAt: number): MutableMessage {
    const message: MutableMessage = {
      role: "assistant",
      content: [],
      toolCalls: [],
      thoughts: [],
      receivedAt: this.#pendingThoughtsAt ?? receivedAt,
    };
    this.#adoptPendingThoughts(message);
    this.#messages.push(message);
    this.#assistant = message;
    return message;
  }

  #adoptPendingThoughts(message: MutableMessage): void {
    if (this.#pendingThoughts.length === 0) return;
    message.thoughts.push(...this.#pendingThoughts);
    this.#pendingThoughts = [];
    this.#pendingThoughtsAt = undefined;
  }

  /** A thought that no assistant content followed (a user message or a turn boundary came first)
   *  is an assistant message of its own; it is never the attach target for later content. */
  #flushPendingThoughts(): void {
    if (this.#pendingThoughts.length === 0) return;
    this.#messages.push({
      role: "assistant",
      content: [],
      toolCalls: [],
      thoughts: this.#pendingThoughts,
      receivedAt: this.#pendingThoughtsAt!,
    });
    this.#pendingThoughts = [];
    this.#pendingThoughtsAt = undefined;
  }
}

/** Fold verbatim update records (a turn's `updates`, a `replay`) into messages. */
export function foldMessages(records: readonly AcpAgentUpdateRecord[]): AcpAgentMessage[] {
  const folder = new MessageFolder();
  for (const { update, receivedAt } of records) folder.apply(update, receivedAt);
  return folder.snapshot();
}
