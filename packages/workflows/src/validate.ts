// Token-free validation for workflow scripts: a static parse (meta literal, syntax,
// determinism blocklist) followed by an optional DRY RUN — the script executes for real
// in the engine's deterministic realm, but every agent() call is served by an in-process
// mock AgentRunner that fabricates schema-conforming results. No ACP process is spawned,
// no tokens are spent, a mock live confirm resolves checkpoints to their declared defaults, and run state is
// journaled nowhere (journaling off + a throwaway persistence root for the run lease).
//
// This is the programmatic core behind `agentprism-workflows validate` (see ./cli.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openWorkflowDir,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowManager,
  parseWorkflowScript,
  redactText,
} from "@automatalabs/workflow-engine";
import { resolveBackendRegistry, selectBackend } from "@automatalabs/acp-agents";
import type { CustomBackendConfig } from "@automatalabs/acp-agents";
import type { WorkflowDir } from "@automatalabs/workflow-engine";
import type { AgentRunner, AgentUsage, WorkflowMeta } from "@automatalabs/shared-types";
import { Check, Errors } from "typebox/value";

export type MockAnswerJson =
  | null
  | boolean
  | number
  | string
  | MockAnswerJson[]
  | { [key: string]: MockAnswerJson };

export interface MockAnswerSequence {
  readonly $sequence: readonly MockAnswerJson[];
}

export type MockAnswerRule = MockAnswerJson | MockAnswerSequence;

/** Label glob -> one reusable answer or one finite answer sequence. */
export type MockAnswers = Readonly<Record<string, MockAnswerRule>>;

export interface ValidateWorkflowOptions {
  /** The `args` global handed to the script during the dry run. */
  args?: unknown;
  /** A workflow directory view (or dir path(s)) serving saved workflows by name, so
   *  nested `workflow("<name>")` calls resolve during the dry run instead of failing. */
  workflows?: string | string[] | WorkflowDir;
  /** Base cwd for the dry run. Default: a throwaway temp dir (so `isolation: "worktree"`
   *  degrades to a no-op instead of creating real worktrees in a repo). */
  cwd?: string;
  /** false => static parse only, no dry run. Default true. */
  dryRun?: boolean;
  /** Set budget.total for the dry run so budget-guarded paths execute. The mock runner
   *  reports 1000 tokens per agent call. */
  tokenBudget?: number;
  /** Cap on dry-run agent calls (defaults to the engine's own cap). */
  maxAgents?: number;
  /** Dry-run wall-clock limit. Default 30_000 ms. */
  timeoutMs?: number;
  /** Dry-run answers selected by the resolved agent label. */
  mockAnswers?: MockAnswers;
}

export interface ValidatedMockAnswerUse {
  glob: string;
  /** Zero-based in the machine report; absent for a reusable single answer. */
  sequenceIndex?: number;
  sequenceLength?: number;
}

export interface ValidatedMockAnswerRule {
  glob: string;
  kind: "single" | "sequence";
  /** Reached calls whose labels matched this glob, including calls won by a later glob. */
  matchingCalls: number;
  /** Calls for which this rule won and reserved an answer, including fixture-validation failures. */
  consumedCalls: number;
  sequenceLength?: number;
}

export interface UnusedMockAnswer {
  glob: string;
  /** Zero-based sequence item; absent for a reusable single answer. */
  sequenceIndex?: number;
  reason: "no-match" | "shadowed" | "not-reached";
}

export interface ValidatedMockAnswers {
  /** Captured normalized rule order, which also documents last-match precedence. */
  rules: ValidatedMockAnswerRule[];
  unused: UnusedMockAnswer[];
}

/** One agent() call observed during the dry run, with its backend attribution. */
export interface ValidatedAgentCall {
  label: string;
  phase?: string;
  /** The model spec the call requested (undefined = the run/session default). */
  model?: string;
  tier?: string;
  mode?: string;
  /** Which backend the spec routes to: "claude" | "codex" | "opencode" | a custom backend
   *  name (suffixed " (script-declared)" when it comes from meta.backends) | "default". */
  backend: string;
  /** True when the call requested structured output. */
  schema: boolean;
  mockAnswer?: ValidatedMockAnswerUse;
}

export interface ValidatedCheckpoint {
  prompt: string;
  kind: string;
  /** The reply the dry-run mock confirm took (the checkpoint's declared default, else true). */
  reply: unknown;
}

export interface ValidateWorkflowReport {
  /** True when the parse succeeded AND the dry run (if performed) completed. */
  ok: boolean;
  /** 0 = valid; 1 = parse/static failure; 2 = dry-run failure. */
  exitCode: 0 | 1 | 2;
  parse: {
    ok: boolean;
    error?: string;
    meta?: WorkflowMeta;
  };
  dryRun?: {
    ok: boolean;
    status: string;
    reason?: string;
    /** True when the run was cut off by ValidateWorkflowOptions.timeoutMs. */
    timedOut: boolean;
    agentCalls: ValidatedAgentCall[];
    checkpoints: ValidatedCheckpoint[];
    phasesVisited: string[];
    logs: string[];
    durationMs: number;
    /** The script's return value, composed from fabricated agent results. */
    result?: unknown;
    mockAnswers?: ValidatedMockAnswers;
  };
  warnings: string[];
}

const MAX_MOCK_ANSWERS_BYTES = 256 * 1024;
const MAX_MOCK_ANSWER_RULES = 256;
const MAX_MOCK_ANSWER_GLOB_LENGTH = 256;
const MAX_MOCK_ANSWER_SEQUENCE_LENGTH = 256;
const MAX_MOCK_ANSWER_DEPTH = 32;
const MAX_FIXTURE_REASON_LENGTH = 1024;

type GlobToken = { kind: "literal"; value: string } | { kind: "one" } | { kind: "many" };

interface NormalizedMockAnswerRule {
  readonly glob: string;
  readonly tokens: readonly GlobToken[];
  readonly kind: "single" | "sequence";
  readonly answers: readonly MockAnswerJson[];
}

interface MockAnswerRuleState {
  matchingCalls: number;
  consumedCalls: number;
}

interface MockAnswerState {
  readonly rules: readonly NormalizedMockAnswerRule[];
  readonly counters: MockAnswerRuleState[];
  readonly inheritedWarnings: Map<string, { ruleIndex: number; label: string; paths: string[]; count: number }>;
}

interface ReservedMockAnswer {
  ruleIndex: number;
  rule: NormalizedMockAnswerRule;
  answer: MockAnswerJson;
  use: ValidatedMockAnswerUse;
}

interface NormalizedSchemaError {
  path: string;
  tokens: string[];
  message: string;
}

function defineDataProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateRecordContainer(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isJsonRecord(value)) throw new TypeError(`${path} must be an ordinary JSON object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${path} must not contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path} must contain only enumerable string-keyed data properties`);
    }
  }
}

function validateArrayContainer(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      throw new TypeError(`${path} arrays must contain only indexed JSON data`);
    }
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError(`${path} must not contain array holes`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path} must contain only enumerable data properties`);
    }
  }
}

function validateJsonGraph(root: unknown, rootPath: string): void {
  const active = new Set<object>();
  const stack: Array<{ value: unknown; path: string; exit?: boolean }> = [{ value: root, path: rootPath }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    const value = item.value;
    if (item.exit) {
      active.delete(value as object);
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError(`${item.path} must contain only finite JSON numbers`);
      continue;
    }
    if (typeof value !== "object") throw new TypeError(`${item.path} must contain only JSON data`);
    if (active.has(value)) throw new TypeError(`${item.path} must not contain cycles`);
    active.add(value);
    stack.push({ value, path: item.path, exit: true });

    if (Array.isArray(value)) {
      validateArrayContainer(value, item.path);
      for (let index = value.length - 1; index >= 0; index--) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw new TypeError(`${item.path} contains invalid array data`);
        stack.push({ value: descriptor.value, path: `${item.path}[${index}]` });
      }
      continue;
    }

    validateRecordContainer(value, item.path);
    const keys = Reflect.ownKeys(value);
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      if (typeof key !== "string") throw new TypeError(`${item.path} contains an invalid symbol key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError(`${item.path} contains an invalid data property`);
      stack.push({ value: descriptor.value, path: `${item.path}.${key}` });
    }
  }
}

function validateJsonData(value: unknown, path: string, depth: number, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${path} must contain only JSON data`);
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`);
  if (depth > MAX_MOCK_ANSWER_DEPTH) {
    throw new TypeError(`${path} exceeds the maximum answer nesting depth of ${MAX_MOCK_ANSWER_DEPTH}`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      validateArrayContainer(value, path);
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw new TypeError(`${path} contains invalid array data`);
        validateJsonData(descriptor.value, `${path}[${index}]`, depth + 1, ancestors);
      }
      return;
    }

    validateRecordContainer(value, path);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`${path} contains an invalid symbol key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError(`${path} contains an invalid data property`);
      validateJsonData(descriptor.value, `${path}.${key}`, depth + 1, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function cloneJsonData(value: MockAnswerJson): MockAnswerJson {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneJsonData(item))) as MockAnswerJson[];
  const output = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype) as Record<string, unknown>;
  for (const key of Object.keys(value)) defineDataProperty(output, key, cloneJsonData(value[key]));
  return Object.freeze(output) as MockAnswerJson;
}

function isCanonicalArrayIndex(key: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  return BigInt(key) <= 4_294_967_294n;
}

function compileMockAnswerGlob(glob: string): readonly GlobToken[] {
  if (glob.length === 0) throw new TypeError("mock-answer globs must not be empty");
  if (glob.length > MAX_MOCK_ANSWER_GLOB_LENGTH) {
    throw new TypeError(`mock-answer glob ${JSON.stringify(glob)} exceeds ${MAX_MOCK_ANSWER_GLOB_LENGTH} UTF-16 code units`);
  }
  const points = Array.from(glob);
  const tokens: GlobToken[] = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (point === "\\") {
      const escaped = points[++index];
      if (escaped === undefined) throw new TypeError(`mock-answer glob ${JSON.stringify(glob)} has a trailing escape`);
      tokens.push(Object.freeze({ kind: "literal", value: escaped }));
    } else if (point === "*") {
      if (tokens.at(-1)?.kind !== "many") tokens.push(Object.freeze({ kind: "many" }));
    } else if (point === "?") {
      tokens.push(Object.freeze({ kind: "one" }));
    } else {
      tokens.push(Object.freeze({ kind: "literal", value: point }));
    }
  }
  return Object.freeze(tokens);
}

function matchesMockAnswerGlob(tokens: readonly GlobToken[], label: string): boolean {
  const points = Array.from(label);
  let current = new Array<boolean>(points.length + 1).fill(false);
  current[0] = true;
  for (const token of tokens) {
    const next = new Array<boolean>(points.length + 1).fill(false);
    if (token.kind === "many") {
      next[0] = current[0];
      for (let index = 1; index <= points.length; index++) next[index] = current[index] || next[index - 1];
    } else {
      for (let index = 1; index <= points.length; index++) {
        next[index] = current[index - 1] && (token.kind === "one" || token.value === points[index - 1]);
      }
    }
    current = next;
  }
  return current[points.length];
}

function normalizeMockAnswers(value: unknown): MockAnswerState {
  if (!isJsonRecord(value)) throw new TypeError("mockAnswers must be an object mapping label globs to answers");
  validateJsonGraph(value, "mockAnswers");
  const globs = Object.keys(value);
  if (globs.length > MAX_MOCK_ANSWER_RULES) {
    throw new TypeError(`mockAnswers supports at most ${MAX_MOCK_ANSWER_RULES} rules`);
  }
  const rules = globs.map((glob): NormalizedMockAnswerRule => {
    if (isCanonicalArrayIndex(glob)) {
      throw new TypeError(`mock-answer glob ${JSON.stringify(glob)} is a reserved canonical array-index key; escape a digit to match a numeric label`);
    }
    const tokens = compileMockAnswerGlob(glob);
    const rawRule = value[glob] as MockAnswerRule;
    if (isJsonRecord(rawRule) && Object.prototype.hasOwnProperty.call(rawRule, "$sequence")) {
      validateRecordContainer(rawRule, `mockAnswers.${glob}`);
      const keys = Object.keys(rawRule);
      if (keys.length !== 1) {
        throw new TypeError(`mock-answer sequence ${JSON.stringify(glob)} must contain only the top-level $sequence property`);
      }
      const sequence = rawRule.$sequence;
      if (!Array.isArray(sequence) || sequence.length === 0) {
        throw new TypeError(`mock-answer sequence ${JSON.stringify(glob)} must be a non-empty array`);
      }
      validateArrayContainer(sequence, `mockAnswers.${glob}.$sequence`);
      if (sequence.length > MAX_MOCK_ANSWER_SEQUENCE_LENGTH) {
        throw new TypeError(`mock-answer sequence ${JSON.stringify(glob)} supports at most ${MAX_MOCK_ANSWER_SEQUENCE_LENGTH} entries`);
      }
      sequence.forEach((answer, index) =>
        validateJsonData(answer, `mockAnswers.${glob}.$sequence[${index}]`, 1, new Set()),
      );
      return Object.freeze({
        glob,
        tokens,
        kind: "sequence",
        answers: Object.freeze(sequence.map((answer) => cloneJsonData(answer))),
      });
    }
    validateJsonData(rawRule, `mockAnswers.${glob}`, 1, new Set());
    return Object.freeze({
      glob,
      tokens,
      kind: "single",
      answers: Object.freeze([cloneJsonData(rawRule as MockAnswerJson)]),
    });
  });

  const canonical = JSON.stringify(value);
  if (Buffer.byteLength(canonical, "utf8") > MAX_MOCK_ANSWERS_BYTES) {
    throw new TypeError(`mockAnswers exceeds the maximum canonical JSON size of ${MAX_MOCK_ANSWERS_BYTES} bytes`);
  }

  return {
    rules: Object.freeze(rules),
    counters: rules.map(() => ({ matchingCalls: 0, consumedCalls: 0 })),
    inheritedWarnings: new Map(),
  };
}

function reserveMockAnswer(state: MockAnswerState, label: string): ReservedMockAnswer | undefined {
  let winningIndex = -1;
  for (let index = 0; index < state.rules.length; index++) {
    if (matchesMockAnswerGlob(state.rules[index].tokens, label)) {
      state.counters[index].matchingCalls++;
      winningIndex = index;
    }
  }
  if (winningIndex < 0) return undefined;

  const rule = state.rules[winningIndex];
  const counter = state.counters[winningIndex];
  if (rule.kind === "sequence" && counter.consumedCalls >= rule.answers.length) {
    const message = redactText(
      `Mock answer sequence exhausted for agent ${JSON.stringify(label)} using glob ${JSON.stringify(rule.glob)}: ` +
        `sequence length ${rule.answers.length}, ${counter.consumedCalls} already consumed.`,
    ).value;
    throw new WorkflowError(truncate(message, MAX_FIXTURE_REASON_LENGTH), WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
      agentLabel: label,
    });
  }

  const sequenceIndex = rule.kind === "sequence" ? counter.consumedCalls : undefined;
  const answer = rule.answers[sequenceIndex ?? 0];
  counter.consumedCalls++;
  return {
    ruleIndex: winningIndex,
    rule,
    answer,
    use: {
      glob: rule.glob,
      ...(sequenceIndex === undefined
        ? {}
        : { sequenceIndex, sequenceLength: rule.answers.length }),
    },
  };
}

function cloneMergeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneMergeValue(item));
  const output = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype) as Record<string, unknown>;
  for (const key of Object.keys(value)) defineDataProperty(output, key, cloneMergeValue((value as Record<string, unknown>)[key]));
  return output;
}

function mergeMockAnswer(
  base: unknown,
  override: MockAnswerJson,
  path: string[],
  replacedPaths: string[][],
): unknown {
  if (isJsonRecord(base) && isJsonRecord(override)) {
    const output = Object.create(Object.getPrototypeOf(base) === null ? null : Object.prototype) as Record<string, unknown>;
    for (const key of Object.keys(base)) defineDataProperty(output, key, cloneMergeValue(base[key]));
    for (const key of Object.keys(override)) {
      if (Object.prototype.hasOwnProperty.call(base, key)) {
        defineDataProperty(output, key, mergeMockAnswer(base[key], override[key], [...path, key], replacedPaths));
      } else {
        replacedPaths.push([...path, key]);
        defineDataProperty(output, key, cloneMergeValue(override[key]));
      }
    }
    return output;
  }
  replacedPaths.push(path);
  return cloneMergeValue(override);
}

function parseJsonPointer(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function renderJsonPointer(tokens: readonly string[]): string {
  if (tokens.length === 0) return "/";
  return `/${tokens.map((token) => token.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function relatedPaths(left: readonly string[], right: readonly string[]): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function normalizedSchemaErrors(schema: unknown, value: unknown): NormalizedSchemaError[] {
  return Errors(schema as never, value).map((error) => {
    const tokens = parseJsonPointer(error.instancePath);
    return { path: error.instancePath, tokens, message: error.message };
  });
}

function schemaFailure(
  label: string,
  reservation: ReservedMockAnswer,
  errors: readonly NormalizedSchemaError[],
): WorkflowError {
  const position = reservation.use.sequenceIndex === undefined
    ? ""
    : ` sequence ${reservation.use.sequenceIndex + 1}/${reservation.use.sequenceLength}`;
  const diagnostics = errors.length === 0
    ? "schema validation could not compare the fabricated base and scripted answer"
    : errors
        .slice(0, 3)
        .map((error) => `${renderJsonPointer(error.tokens)} ${error.message}`)
        .join("; ");
  const message = redactText(
    `Mock answer for agent ${JSON.stringify(label)} from glob ${JSON.stringify(reservation.rule.glob)}${position} ` +
      `failed schema validation: ${diagnostics}`,
  ).value;
  return new WorkflowError(truncate(message, MAX_FIXTURE_REASON_LENGTH), WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, {
    recoverable: false,
    agentLabel: label,
  });
}

function applyStructuredMockAnswer(
  schema: unknown,
  base: unknown,
  reservation: ReservedMockAnswer,
  label: string,
  state: MockAnswerState,
): unknown {
  const replacedPaths: string[][] = [];
  const merged = mergeMockAnswer(base, reservation.answer, [], replacedPaths);
  try {
    if (Check(schema as never, merged)) return merged;
    Check(schema as never, base);
    const mergedErrors = normalizedSchemaErrors(schema, merged);
    const baseErrors = normalizedSchemaErrors(schema, base);
    const baseFingerprints = new Set(baseErrors.map((error) => `${error.path}\u0000${error.message}`));
    const introduced = mergedErrors.filter(
      (error) =>
        !baseFingerprints.has(`${error.path}\u0000${error.message}`) ||
        replacedPaths.some((replaced) => relatedPaths(error.tokens, replaced)),
    );
    if (introduced.length > 0) throw schemaFailure(label, reservation, introduced);

    const paths = [...new Set(mergedErrors.map((error) => renderJsonPointer(error.tokens)))];
    const warningKey = `${reservation.ruleIndex}\u0000${label}\u0000${paths.join("\u0000")}`;
    const previous = state.inheritedWarnings.get(warningKey);
    if (previous) previous.count++;
    else state.inheritedWarnings.set(warningKey, { ruleIndex: reservation.ruleIndex, label, paths, count: 1 });
    return merged;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw schemaFailure(label, reservation, []);
  }
}

function applyTextMockAnswer(reservation: ReservedMockAnswer, label: string): string {
  if (typeof reservation.answer === "string" && reservation.answer.trim().length > 0) return reservation.answer;
  throw schemaFailure(label, reservation, [
    { path: "", tokens: [], message: "Expected a non-blank string for a schema-less agent call" },
  ]);
}

function buildMockAnswersReport(state: MockAnswerState): ValidatedMockAnswers {
  const rules = state.rules.map((rule, index): ValidatedMockAnswerRule => ({
    glob: rule.glob,
    kind: rule.kind,
    matchingCalls: state.counters[index].matchingCalls,
    consumedCalls: state.counters[index].consumedCalls,
    ...(rule.kind === "sequence" ? { sequenceLength: rule.answers.length } : {}),
  }));
  const unused: UnusedMockAnswer[] = [];
  for (let ruleIndex = 0; ruleIndex < state.rules.length; ruleIndex++) {
    const rule = state.rules[ruleIndex];
    const counter = state.counters[ruleIndex];
    if (rule.kind === "single") {
      if (counter.consumedCalls === 0) {
        unused.push({
          glob: rule.glob,
          reason: counter.matchingCalls === 0 ? "no-match" : "shadowed",
        });
      }
      continue;
    }
    for (let sequenceIndex = counter.consumedCalls; sequenceIndex < rule.answers.length; sequenceIndex++) {
      unused.push({
        glob: rule.glob,
        sequenceIndex,
        reason:
          counter.matchingCalls === 0
            ? "no-match"
            : counter.consumedCalls === 0
              ? "shadowed"
              : "not-reached",
      });
    }
  }
  return { rules, unused };
}

function appendMockAnswerWarnings(
  state: MockAnswerState,
  report: ValidatedMockAnswers,
  warnings: string[],
): void {
  for (let ruleIndex = 0; ruleIndex < state.rules.length; ruleIndex++) {
    for (const incident of state.inheritedWarnings.values()) {
      if (incident.ruleIndex !== ruleIndex) continue;
      const shownPaths = incident.paths.slice(0, 3);
      const more = incident.paths.length > shownPaths.length ? ` (+${incident.paths.length - shownPaths.length} more)` : "";
      warnings.push(
        `mock-answer rule ${JSON.stringify(state.rules[ruleIndex].glob)} for agent ${JSON.stringify(incident.label)} ` +
          `was accepted with pre-existing fabricated-default limitations at ${shownPaths.join(", ")}${more} ` +
          `(${incident.count} occurrence${incident.count === 1 ? "" : "s"})`,
      );
    }
    const unused = report.unused.filter((entry) => entry.glob === state.rules[ruleIndex].glob);
    if (unused.length > 0) {
      const reasons = [...new Set(unused.map((entry) => entry.reason))].join(", ");
      warnings.push(
        `mock-answer rule ${JSON.stringify(state.rules[ruleIndex].glob)} has ${unused.length} unused answer` +
          `${unused.length === 1 ? "" : "s"} (${reasons})`,
      );
    }
  }
}

/**
 * Fabricate a value that structurally satisfies a JSON Schema — the dry run's stand-in
 * for a real agent's structured output. Deterministic and intentionally simple: first
 * enum/anyOf variant, `true` booleans (so ok-gates terminate), `mock-<field>` strings.
 */
export function fabricateFromSchema(schema: unknown, hint = "value", depth = 0): unknown {
  if (depth > 16) return null;
  if (!schema || typeof schema !== "object") return `mock-${hint}`;
  const s = schema as Record<string, unknown>;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if (s.default !== undefined) return s.default;
  const variants = s.anyOf ?? s.oneOf ?? s.allOf;
  if (Array.isArray(variants) && variants.length > 0) return fabricateFromSchema(variants[0], hint, depth + 1);

  let type = s.type;
  if (Array.isArray(type)) type = type[0];
  if (type === undefined) {
    if (s.properties) type = "object";
    else if (s.items) type = "array";
    else return `mock-${hint}`;
  }

  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, unknown>;
      for (const [name, sub] of Object.entries(props)) {
        defineDataProperty(out, name, fabricateFromSchema(sub, name, depth + 1));
      }
      for (const name of Array.isArray(s.required) ? (s.required as string[]) : []) {
        if (!Object.prototype.hasOwnProperty.call(out, name)) defineDataProperty(out, name, `mock-${name}`);
      }
      return out;
    }
    case "array": {
      const min = typeof s.minItems === "number" ? s.minItems : 1;
      const count = Math.min(Math.max(min, 1), 3);
      return Array.from({ length: count }, (_x, i) => fabricateFromSchema(s.items, `${hint}-${i + 1}`, depth + 1));
    }
    case "string": {
      if (s.format === "uri" || s.format === "url") return "https://example.invalid/mock";
      if (s.format === "date-time") return "2024-01-01T00:00:00Z";
      if (s.format === "date") return "2024-01-01";
      let value = `mock-${hint}`;
      if (typeof s.minLength === "number" && value.length < s.minLength) {
        value = value.padEnd(s.minLength, "x");
      }
      if (typeof s.maxLength === "number" && value.length > s.maxLength) {
        value = value.slice(0, s.maxLength);
      }
      return value;
    }
    case "integer":
    case "number": {
      if (typeof s.minimum === "number") return s.minimum;
      if (typeof s.maximum === "number" && (s.maximum as number) < 1) return s.maximum;
      return 1;
    }
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return `mock-${hint}`;
  }
}

/** The RunOptions fields the mock runner reads. The engine binds the seam's frozen field
 *  names through a cast (see shared-types RunOptions), mirrored here to keep this module
 *  free of the typebox generic plumbing. */
interface MockRunOptions {
  label?: string;
  model?: string;
  tier?: string;
  mode?: string;
  schema?: unknown;
  onUsage?: (usage: AgentUsage) => void;
}

/** Tokens the mock runner reports per agent call, so `--token-budget` exercises
 *  budget-guarded script paths deterministically. */
export const MOCK_TOKENS_PER_AGENT = 1000;

function attributeBackend(
  model: string | undefined,
  tier: string | undefined,
  declared: Record<string, unknown> | undefined,
): string {
  const spec = model ?? tier;
  if (!spec) return "default";
  const head = spec.split("/")[0].replace(/\[[^\]]*\]\s*$/, "").trim().toLowerCase();
  if (declared && Object.keys(declared).some((name) => name.toLowerCase() === head)) {
    return `${head} (script-declared)`;
  }
  try {
    const registry = resolveBackendRegistry(declared as Record<string, CustomBackendConfig> | undefined);
    return selectBackend({ model, tier }, registry).id;
  } catch {
    return "default";
  }
}

/**
 * Validate a workflow script: parse it, then (by default) dry-run it against a mock
 * AgentRunner. Never throws for an invalid script — read `report.ok` / `report.exitCode`.
 */
export async function validateWorkflowScript(
  script: string,
  options: ValidateWorkflowOptions = {},
): Promise<ValidateWorkflowReport> {
  const mockAnswerState = options.mockAnswers === undefined ? undefined : normalizeMockAnswers(options.mockAnswers);
  const warnings: string[] = [];

  let meta: WorkflowMeta;
  try {
    meta = parseWorkflowScript(script).meta;
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      parse: { ok: false, error: error instanceof Error ? error.message : String(error) },
      warnings,
    };
  }

  const declaredBackends = meta.backends && Object.keys(meta.backends).length > 0 ? meta.backends : undefined;
  if (declaredBackends) {
    warnings.push(
      `script declares custom backends (${Object.keys(declaredBackends).join(", ")}) — real runs must approve them ` +
        `(allowScriptBackends / exec.scriptBackends / AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1); the dry run treats them as approved`,
    );
  }

  if (options.dryRun === false) {
    return { ok: true, exitCode: 0, parse: { ok: true, meta }, warnings };
  }

  // Throwaway directories: the run cwd (unless the caller pins one) so worktree isolation
  // no-ops, and a private persistence root so the run lease never touches the real store.
  const ownedCwd = options.cwd === undefined;
  const baseCwd = options.cwd ?? mkdtempSync(join(tmpdir(), "agentprism-validate-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "agentprism-validate-state-"));

  const agentCalls: ValidatedAgentCall[] = [];
  const pendingAgentCalls: ValidatedAgentCall[] = [];
  const checkpoints: ValidatedCheckpoint[] = [];
  const mockMeta = new Map<string, { tier?: string; mode?: string; schema: boolean }>();
  const runner = {
    async run(_prompt: string, runOptions: MockRunOptions = {}) {
      const label = runOptions.label ?? "";
      const metadata = {
        tier: runOptions.tier,
        mode: runOptions.mode,
        schema: runOptions.schema !== undefined,
      };
      mockMeta.set(label, metadata);
      const pendingCall = mockAnswerState ? pendingAgentCalls.shift() : undefined;
      if (pendingCall) {
        pendingCall.tier = metadata.tier;
        pendingCall.mode = metadata.mode;
        pendingCall.schema = metadata.schema;
        pendingCall.backend = attributeBackend(pendingCall.model, metadata.tier, declaredBackends);
      }

      const base = runOptions.schema === undefined ? undefined : fabricateFromSchema(runOptions.schema);
      const reservation = mockAnswerState ? reserveMockAnswer(mockAnswerState, label) : undefined;
      if (reservation && pendingCall) pendingCall.mockAnswer = reservation.use;
      runOptions.onUsage?.({
        input: MOCK_TOKENS_PER_AGENT - 250,
        output: 250,
        cacheRead: 0,
        cacheWrite: 0,
        total: MOCK_TOKENS_PER_AGENT,
        cost: 0,
      });
      if (runOptions.schema !== undefined) {
        if (!reservation) return base;
        return applyStructuredMockAnswer(runOptions.schema, base, reservation, label, mockAnswerState!);
      }
      if (reservation) return applyTextMockAnswer(reservation, label);
      return `[dry-run] mock output for ${runOptions.label ?? "agent"}`;
    },
  } as unknown as AgentRunner;

  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  const flows =
    options.workflows === undefined
      ? undefined
      : typeof options.workflows === "string" || Array.isArray(options.workflows)
        ? openWorkflowDir(options.workflows)
        : options.workflows;

  const manager = new WorkflowManager({
    agent: runner,
    cwd: baseCwd,
    ...(mockAnswerState ? { concurrency: 1 } : {}),
    journaling: false,
    persistenceRoot,
    loadSavedWorkflow: flows?.resolve,
  });
  manager.on("agentStart", (event: { label: string; phase?: string; model?: string }) => {
    const extra = mockMeta.get(event.label) ?? mockMeta.get("") ?? { schema: false };
    const call: ValidatedAgentCall = {
      label: event.label,
      phase: event.phase,
      model: event.model,
      tier: extra.tier,
      mode: extra.mode,
      backend: attributeBackend(event.model, extra.tier, declaredBackends),
      schema: extra.schema,
    };
    agentCalls.push(call);
    if (mockAnswerState) pendingAgentCalls.push(call);
  });

  try {
    const run = await manager.runSync(script, options.args, {
      journaling: false,
      signal: controller.signal,
      tokenBudget: options.tokenBudget,
      maxAgents: options.maxAgents,
      scriptBackends: declaredBackends,
      confirm: async (promptText: string, checkpointOptions: unknown) => {
        const opts = (checkpointOptions ?? {}) as { kind?: string; default?: unknown; headless?: string };
        if (opts.headless === "abort") {
          warnings.push(
            `checkpoint "${truncate(promptText, 60)}" sets headless: "abort" — unattended runs will fail at it`,
          );
        }
        // Mirror the engine's headless resolution exactly: the declared default, else true.
        const reply = opts.default ?? true;
        checkpoints.push({ prompt: promptText, kind: opts.kind ?? "confirm", reply });
        return reply;
      },
    });

    // agentStart fires BEFORE the mock records its options, so backfill attribution for
    // any call whose mock metadata arrived after the event (same tick ordering).
    if (!mockAnswerState) {
      for (const call of agentCalls) {
        const extra = mockMeta.get(call.label);
        if (extra) {
          call.tier = extra.tier;
          call.mode = extra.mode;
          call.schema = extra.schema;
          call.backend = attributeBackend(call.model, extra.tier, declaredBackends);
        }
      }
    }

    const ok = run.status === "completed";
    if (!ok && flows === undefined && run.reason?.includes("must be the first statement") && /\bworkflow\s*\(/.test(script)) {
      warnings.push(
        'the failure looks like a nested workflow("<name>") call on a bare name — provide workflow dirs ' +
          "(ValidateWorkflowOptions.workflows / --workflows-dir) so names resolve during the dry run",
      );
    }
    if (ok) {
      if (agentCalls.length === 0 && checkpoints.length === 0) {
        warnings.push("the script completed without a single agent() or checkpoint() call");
      }
      const declaredPhases = (meta.phases ?? []).map((p) => p.title);
      // A phase counts as used via phase() OR via a per-call agent({ phase }) assignment.
      const visited = new Set([...(run.phases ?? []), ...agentCalls.flatMap((c) => (c.phase ? [c.phase] : []))]);
      for (const title of declaredPhases) {
        if (!visited.has(title)) warnings.push(`meta.phases declares "${title}" but no phase("${title}") or agent({ phase }) used it`);
      }
      if (declaredPhases.length > 0) {
        for (const title of visited) {
          if (!declaredPhases.includes(title)) warnings.push(`phase "${title}" is used but meta.phases does not declare it`);
        }
      }
    }

    const mockAnswers = mockAnswerState ? buildMockAnswersReport(mockAnswerState) : undefined;
    if (mockAnswerState && mockAnswers) appendMockAnswerWarnings(mockAnswerState, mockAnswers, warnings);

    return {
      ok,
      exitCode: ok ? 0 : 2,
      parse: { ok: true, meta },
      dryRun: {
        ok,
        status: run.status,
        reason: timedOut ? `dry run exceeded ${timeoutMs}ms and was aborted` : run.reason,
        timedOut,
        agentCalls,
        checkpoints,
        phasesVisited: run.phases ?? [],
        logs: run.logs ?? [],
        durationMs: run.durationMs,
        result: run.result,
        ...(mockAnswers ? { mockAnswers } : {}),
      },
      warnings,
    };
  } finally {
    clearTimeout(timer);
    try {
      rmSync(persistenceRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    if (ownedCwd) {
      try {
        rmSync(baseCwd, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Render a ValidateWorkflowReport as the human-readable CLI output. */
export function formatValidateReport(report: ValidateWorkflowReport): string {
  const lines: string[] = [];
  if (report.parse.ok) {
    const meta = report.parse.meta;
    const phases = meta?.phases?.length ? `${meta.phases.length} declared phase(s)` : "no declared phases";
    const backends = meta?.backends ? `, ${Object.keys(meta.backends).length} script-declared backend(s)` : "";
    lines.push(`✓ parse     "${meta?.name}" — ${phases}${backends}`);
  } else {
    lines.push(`✗ parse     ${report.parse.error}`);
  }

  const dry = report.dryRun;
  if (dry) {
    const summary = `${dry.agentCalls.length} agent call(s), ${dry.checkpoints.length} checkpoint(s), ${dry.durationMs}ms`;
    lines.push(dry.ok ? `✓ dry run   completed — ${summary}` : `✗ dry run   ${dry.status} — ${dry.reason ?? "unknown failure"} (${summary})`);
    for (const call of dry.agentCalls) {
      const spec = call.model ?? (call.tier ? `tier=${call.tier}` : "(default model)");
      const mock = call.mockAnswer
        ? `mock=${JSON.stringify(call.mockAnswer.glob)}` +
          (call.mockAnswer.sequenceIndex === undefined
            ? ""
            : `[${call.mockAnswer.sequenceIndex + 1}/${call.mockAnswer.sequenceLength}]`)
        : undefined;
      const bits = [call.phase ? `[${call.phase}]` : undefined, spec, `→ ${call.backend}`, call.schema ? "(schema)" : undefined, call.mode ? `mode=${call.mode}` : undefined, mock]
        .filter(Boolean)
        .join("  ");
      lines.push(`    • ${call.label}  ${bits}`);
    }
    for (const cp of dry.checkpoints) {
      lines.push(`    ◆ checkpoint [${cp.kind}] "${truncate(cp.prompt, 60)}" → ${JSON.stringify(cp.reply)}`);
    }
  } else if (report.parse.ok) {
    lines.push("- dry run   skipped (--parse-only)");
  }

  for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  lines.push(report.ok ? "result: valid" : "result: INVALID");
  return lines.join("\n");
}
