// Area (5): toolNames/disallowedToolNames -> request_permission auto-responses.
// The headless runner decides allow/deny at the ACP permission boundary, matching
// best-effort against the request's title, kind, and any vendor _meta.*.toolName.
import test from "node:test";
import assert from "node:assert/strict";
import type { PermissionOption, RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import {
  decidePermission,
  resolvePermission,
  withPersist,
  type PermissionResolution,
  type ToolPolicy,
} from "../src/index.js";

const ALLOW_ONCE: PermissionOption = { optionId: "allow-1", name: "Allow", kind: "allow_once" };
const ALLOW_ALWAYS: PermissionOption = { optionId: "allow-2", name: "Always", kind: "allow_always" };
const REJECT_ONCE: PermissionOption = { optionId: "reject-1", name: "Reject", kind: "reject_once" };
const REJECT_ALWAYS: PermissionOption = { optionId: "reject-2", name: "Always reject", kind: "reject_always" };

function req(
  toolCall: { title?: string; kind?: ToolKind; meta?: Record<string, unknown> },
  options: PermissionOption[] = [ALLOW_ONCE, REJECT_ONCE],
): RequestPermissionRequest {
  return {
    sessionId: "s1",
    toolCall: {
      toolCallId: "tc-1",
      ...(toolCall.title ? { title: toolCall.title } : {}),
      ...(toolCall.kind ? { kind: toolCall.kind } : {}),
      ...(toolCall.meta ? { _meta: toolCall.meta } : {}),
    },
    options,
  };
}

function selectedId(r: ReturnType<typeof decidePermission>): string | undefined {
  return r.outcome.outcome === "selected" ? r.outcome.optionId : undefined;
}

test("default (no policy) ALLOWS — a headless subagent can do real work", () => {
  assert.equal(selectedId(decidePermission(req({ title: "Read file", kind: "read" }), {})), "allow-1");
});

test("deny-list match REJECTS (matched against title/kind/meta toolName)", () => {
  const policy: ToolPolicy = { deny: ["bash"] };
  // match by title substring
  assert.equal(selectedId(decidePermission(req({ title: "Run Bash command" }), policy)), "reject-1");
  // match by vendor _meta toolName (Claude stamps it nested)
  assert.equal(
    selectedId(decidePermission(req({ title: "Execute", meta: { claude: { toolName: "Bash" } } }), policy)),
    "reject-1",
  );
  // unrelated tool is allowed
  assert.equal(selectedId(decidePermission(req({ title: "Read file" }), policy)), "allow-1");
});

test("non-empty allow-list: a tool matching NOTHING is denied; a match is allowed", () => {
  const policy: ToolPolicy = { allow: ["read", "grep"] };
  assert.equal(selectedId(decidePermission(req({ title: "Read file" }), policy)), "allow-1");
  assert.equal(selectedId(decidePermission(req({ title: "Write file" }), policy)), "reject-1");
});

test("deny is applied AFTER allow: a tool on both lists is denied", () => {
  const policy: ToolPolicy = { allow: ["bash", "read"], deny: ["bash"] };
  assert.equal(selectedId(decidePermission(req({ title: "bash" }), policy)), "reject-1");
  assert.equal(selectedId(decidePermission(req({ title: "read" }), policy)), "allow-1");
});

test("kind participates in matching when there is no title", () => {
  assert.equal(selectedId(decidePermission(req({ kind: "execute" }), { deny: ["execute"] })), "reject-1");
});

test("option-kind preference order: allow_always/reject_always when *_once is absent", () => {
  // want-allow, only allow_always offered
  assert.equal(selectedId(decidePermission(req({ title: "x" }, [ALLOW_ALWAYS, REJECT_ONCE]), {})), "allow-2");
  // want-reject, only reject_always offered
  assert.equal(
    selectedId(decidePermission(req({ title: "bash" }, [ALLOW_ONCE, REJECT_ALWAYS]), { deny: ["bash"] })),
    "reject-2",
  );
});

test("no option of the desired polarity exists => cancelled (the only way to refuse)", () => {
  // want to reject, but the server offers ONLY allow options => cancel the permission
  const r = decidePermission(req({ title: "bash" }, [ALLOW_ONCE, ALLOW_ALWAYS]), { deny: ["bash"] });
  assert.deepEqual(r.outcome, { outcome: "cancelled" });
});

test("empty allow/deny arrays behave as 'no policy' (allow)", () => {
  assert.equal(selectedId(decidePermission(req({ title: "anything" }), { allow: [], deny: [] })), "allow-1");
});

test("defaultOutcome: deny flips only the no-match fallback", () => {
  assert.equal(selectedId(decidePermission(req({ title: "anything" }), { defaultOutcome: "deny" })), "reject-1");
  assert.equal(
    selectedId(decidePermission(req({ title: "Read file" }), { allow: ["read"], defaultOutcome: "deny" })),
    "allow-1",
  );
});

test("matching is case-insensitive and bidirectional substring", () => {
  // pattern longer than the candidate name still matches (p.includes(n))
  assert.equal(selectedId(decidePermission(req({ title: "rm" }), { deny: ["rm -rf"] })), "reject-1");
  // candidate longer than the pattern matches (n.includes(p))
  assert.equal(selectedId(decidePermission(req({ title: "ReadFileTool" }), { allow: ["read"] })), "allow-1");
});

// ---- precedence ladder: EXACT (toolName-first) before the substring fallback ----------

test("exact name wins: an exact allow on the tool id beats a loose substring deny", () => {
  // The operator allows EXACTLY the `thread-reader` tool and denies the `read` tool. Under
  // the old bidirectional substring, deny `read` ⊂ `thread-reader` would (wrongly) REJECT
  // the very tool the allow-list named. With the ladder, the exact allow pins the tool, so
  // the loose `read` deny is suppressed and the tool is ALLOWED.
  const policy: ToolPolicy = { allow: ["thread-reader"], deny: ["read"] };
  assert.equal(selectedId(decidePermission(req({ title: "thread-reader" }), policy)), "allow-1");
  // ...and the genuinely-`read` tool the deny meant is still rejected (it is not exactly
  // allow-listed, and `read` exactly matches the deny entry).
  assert.equal(selectedId(decidePermission(req({ title: "read" }), policy)), "reject-1");
});

test("'read' no longer matches 'thread-reader' once an exact entry pins the tool", () => {
  // deny `read`, but the tool is exactly allow-listed as `thread-reader` (so it is precisely
  // identified). The substring `read` ⊂ `thread-reader` is suppressed -> ALLOWED, not denied.
  const pinned: ToolPolicy = { allow: ["thread-reader"], deny: ["read"] };
  assert.equal(selectedId(decidePermission(req({ title: "thread-reader" }), pinned)), "allow-1");
  // RESIDUAL AMBIGUITY (documented in permissions.ts): with NO exact entry to pin the tool,
  // the loose substring fallback still treats `read` as matching `thread-reader`.
  assert.equal(selectedId(decidePermission(req({ title: "thread-reader" }), { deny: ["read"] })), "reject-1");
});

test("the authoritative _meta.toolName drives the EXACT match over the human title", () => {
  // Human title is prose; the real tool id is stamped in _meta. An exact deny on the tool id
  // rejects even though the title would not exactly match anything.
  const policy: ToolPolicy = { deny: ["bash"] };
  assert.equal(
    selectedId(decidePermission(req({ title: "Run shell command", meta: { claude: { toolName: "Bash" } } }), policy)),
    "reject-1",
  );
  // An exactly allow-listed tool id is allowed; a sibling tool id that is NOT listed is denied.
  const allowPolicy: ToolPolicy = { allow: ["Read"] };
  assert.equal(
    selectedId(decidePermission(req({ title: "x", meta: { claude: { toolName: "read" } } }), allowPolicy)),
    "allow-1",
  );
  assert.equal(
    selectedId(decidePermission(req({ title: "x", meta: { claude: { toolName: "Write" } } }), allowPolicy)),
    "reject-1",
  );
});

// ---- tool-approval `_meta.persist` echo (§3.6/PR7) --------------------------------------------
// Codex reads a persistence directive to remember an approval (dist/index.js:23952-23975). Both the
// headless auto-responder (ToolPolicy.persist) and the high-level `resolvePermission` echo it as
// `_meta.persist` on the RequestPermission response; an agent without the capability ignores it.

function persistOf(r: ReturnType<typeof decidePermission>): unknown {
  return (r as { _meta?: Record<string, unknown> })._meta?.persist;
}

test("decidePermission echoes ToolPolicy.persist as _meta.persist ONLY when it allows", () => {
  // Allowed -> persist echoed.
  const allowed = decidePermission(req({ title: "Read file" }), { persist: "session" });
  assert.equal(selectedId(allowed), "allow-1");
  assert.equal(persistOf(allowed), "session");

  // Denied -> no persist echo (a denial remembers nothing).
  const denied = decidePermission(req({ title: "Run bash" }), { deny: ["bash"], persist: "always" });
  assert.equal(selectedId(denied), "reject-1");
  assert.equal(persistOf(denied), undefined);

  // No persist directive -> no `_meta` at all (unchanged default shape).
  const plain = decidePermission(req({ title: "Read file" }), {});
  assert.equal((plain as { _meta?: unknown })._meta, undefined);
});

test("decidePermission persist echo rides through the allow_always fallback option too", () => {
  const r = decidePermission(req({ title: "x" }, [ALLOW_ALWAYS, REJECT_ONCE]), { persist: "always" });
  assert.equal(selectedId(r), "allow-2");
  assert.equal(persistOf(r), "always");
});

test("resolvePermission maps {outcome,persist} onto a concrete ACP response", () => {
  const allow: PermissionResolution = { outcome: "allow", persist: "always" };
  const rAllow = resolvePermission(req({ title: "x" }), allow);
  assert.equal(selectedId(rAllow), "allow-1");
  assert.equal(persistOf(rAllow), "always");

  // Deny picks a reject option and never persists.
  const rDeny = resolvePermission(req({ title: "x" }), { outcome: "deny", persist: "session" });
  assert.equal(selectedId(rDeny), "reject-1");
  assert.equal(persistOf(rDeny), undefined);

  // Allow with no persist -> no `_meta`.
  const rBare = resolvePermission(req({ title: "x" }), { outcome: "allow" });
  assert.equal((rBare as { _meta?: unknown })._meta, undefined);
});

test("resolvePermission cancels when the agent offers no option of the requested polarity", () => {
  // Wants to deny but only allow options exist -> cancelled (matches the auto-responder contract).
  const r = resolvePermission(req({ title: "x" }, [ALLOW_ONCE, ALLOW_ALWAYS]), { outcome: "deny" });
  assert.deepEqual(r.outcome, { outcome: "cancelled" });
});

test("withPersist is a pure, non-mutating echo that leaves cancelled/undirected responses untouched", () => {
  const selected = { outcome: { outcome: "selected", optionId: "allow-1" } } as const;
  const stamped = withPersist(selected, "session");
  assert.equal((stamped as { _meta?: Record<string, unknown> })._meta?.persist, "session");
  // Input is never mutated.
  assert.equal((selected as { _meta?: unknown })._meta, undefined);
  // No directive -> identity.
  assert.equal(withPersist(selected, undefined), selected);
  // Cancelled -> identity (cannot persist a refusal).
  const cancelled = { outcome: { outcome: "cancelled" } } as const;
  assert.equal(withPersist(cancelled, "always"), cancelled);
  // Existing `_meta` is preserved alongside the persist key.
  const withMeta = { outcome: { outcome: "selected", optionId: "allow-1" }, _meta: { keep: 1 } } as const;
  const merged = withPersist(withMeta, "always") as { _meta: Record<string, unknown> };
  assert.deepEqual(merged._meta, { keep: 1, persist: "always" });
});
