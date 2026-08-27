// Token-free validation for workflow scripts: a static parse (meta literal, syntax,
// direct nondeterministic call expressions) followed by an optional DRY RUN — the script
// executes for real in the engine's deterministic realm, but every agent() call is served by
// an in-process mock AgentRunner that fabricates schema-conforming results. Afterward, each
// routed ACP backend/model pair is opened once without a prompt to read its advertised modes and config options.
// No tokens are spent, a mock live confirm resolves checkpoints to their declared defaults,
// and run state is journaled nowhere (journaling off + a throwaway persistence root for the run lease).
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
import {
  BUILTIN_BACKEND_IDS,
  builtinThoughtLevelDomainSemantics,
  registryWithRunBackends,
  resolveBackendRegistry,
  selectBackend,
} from "@automatalabs/acp-agents";
import type {
  BackendRegistry,
  CustomBackendConfig,
  SessionConfigOption,
  SessionModeState,
  ThoughtLevelDomainSemantics,
} from "@automatalabs/acp-agents";
import type { WorkflowDir } from "@automatalabs/workflow-engine";
import type { AgentRunner, AgentUsage, WorkflowMeta } from "@automatalabs/shared-types";
import { Check, Errors } from "typebox/value";
import { createValidateProbeRunner, type ValidateProbeRunner } from "./validate-internal.js";

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
  /** Cap on dry-run agent calls (defaults to the engine's own cap). */
  maxAgents?: number;
  /** Dry-run wall-clock limit. Default 30_000 ms. */
  timeoutMs?: number;
  /** Per routed backend/model config-probe limit. Default 60_000 ms. */
  probeTimeoutMs?: number;
  /** Host-owned no-prompt probe runner. When supplied it is reused and never disposed. */
  probeRunner?: ValidateProbeRunner;
  /** Optional saved-workflow resolver used by nested workflow("name") calls in the dry run. */
  loadSavedWorkflow?: (name: string) => string | undefined;
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
  /** The verbatim model spec the call requested (undefined = the run/session default). */
  model?: string;
  tier?: string;
  mode?: string;
  /** The verbatim session config options authored for this call. */
  configOptions?: Record<string, string | boolean>;
  /** Which concrete registry built-in or custom backend the spec routes to (suffixed
   *  " (script-declared)" when it comes from meta.backends). */
  backend: string;
  /** True when the call requested structured output. */
  schema: boolean;
  mockAnswer?: ValidatedMockAnswerUse;
}

export interface ValidateHarnessOptions {
  backendId: string;
  /** The call's verbatim selected model; absent means the harness/session default. */
  model?: string;
  probed: boolean;
  /** Present when probed=false: the harness's spawn/auth/session error. */
  error?: string;
  /** Effective advertised ACP modes; null means this backend/model supports no session modes. */
  modes?: SessionModeState | null;
  options?: SessionConfigOption[];
}

export interface ValidatedCheckpoint {
  prompt: string;
  kind: string;
  /** The reply the dry-run mock confirm took (the checkpoint's declared default, else true). */
  reply: unknown;
}

export interface ValidateWorkflowReport {
  /** True when parse, dry run, and all checks against successfully probed catalogs pass. */
  ok: boolean;
  /** 0 = valid; 1 = parse/static failure; 2 = dry-run or config-option failure. */
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
    /** Fresh, per-run advertised mode and config-option catalogs for every routed backend/model pair. */
    harnessOptions?: ValidateHarnessOptions[];
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
const CONFIG_OPTION_META_NAMESPACE = "@automatalabs/agentprism";

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
  configOptions?: Record<string, string | boolean>;
  schema?: unknown;
  onUsage?: (usage: AgentUsage) => void;
}

/** Tokens the mock runner reports per agent call (the dry-run token accounting). */
export const MOCK_TOKENS_PER_AGENT = 1000;

/** Maximum advertised model count for client-side ordered thought-domain enumeration.
 *  Larger catalogs stay on exact advertised-value validation so zero-token validation remains bounded. */
export const ORDERED_THOUGHT_LEVEL_ENUMERATION_MODEL_LIMIT = 32;

interface RoutedBackend {
  backendId: string;
  display: string;
  thoughtLevelDomainSemantics: ThoughtLevelDomainSemantics;
}

function routeBackend(
  model: string | undefined,
  tier: string | undefined,
  registry: BackendRegistry,
  hostRegistry: BackendRegistry,
  declared: Record<string, CustomBackendConfig> | undefined,
): RoutedBackend {
  const backend = selectBackend({ model, tier }, registry);
  const backendId = backend.id;
  const scriptDeclared =
    !hostRegistry.has(backendId) &&
    Object.keys(declared ?? {}).some((name) => name.toLowerCase() === backendId.toLowerCase());
  return {
    backendId,
    display: scriptDeclared ? `${backendId} (script-declared)` : backendId,
    // Auth profiles are a built-in-only contract. A custom backend that shadows a built-in id
    // therefore stays exact-set instead of inheriting that built-in's ordering declaration.
    thoughtLevelDomainSemantics:
      (backend.authProfile === undefined
        ? undefined
        : builtinThoughtLevelDomainSemantics(backendId)) ?? "exact-set",
  };
}

function registryOptions(registry: BackendRegistry): Record<string, CustomBackendConfig> | undefined {
  if (registry.size === 0) return undefined;
  return Object.fromEntries(
    [...registry].map(([name, entry]) => {
      const { name: _name, ...config } = entry;
      return [name, config];
    }),
  );
}

interface ProbeStageResult {
  harnessOptions: ValidateHarnessOptions[];
  catalogs: Map<string, SessionConfigOption[]>;
  modes: Map<string, SessionModeState | null>;
}

interface ConfigProbeTarget {
  backendId: string;
  model?: string;
  thoughtLevelDomainSemantics: ThoughtLevelDomainSemantics;
}

function configCatalogKey(backendId: string, model: string | undefined): string {
  return JSON.stringify([backendId, model ?? null]);
}

function configProbeTargets(
  calls: ValidatedAgentCall[],
  registry: BackendRegistry,
  hostRegistry: BackendRegistry,
  declared: Record<string, CustomBackendConfig> | undefined,
): ConfigProbeTarget[] {
  const targets = new Map<string, ConfigProbeTarget>();
  for (const call of calls) {
    const routed = routeBackend(call.model, call.tier, registry, hostRegistry, declared);
    const backendId = routed.backendId;
    const target: ConfigProbeTarget = call.model === undefined
      ? { backendId, thoughtLevelDomainSemantics: routed.thoughtLevelDomainSemantics }
      : {
          backendId,
          model: call.model,
          thoughtLevelDomainSemantics: routed.thoughtLevelDomainSemantics,
        };
    targets.set(configCatalogKey(backendId, call.model), target);
  }
  return [...targets.values()].sort((left, right) =>
    left.backendId.localeCompare(right.backendId) || (left.model ?? "").localeCompare(right.model ?? ""),
  );
}

function probeTargetName(target: ConfigProbeTarget): string {
  return target.model === undefined
    ? `${target.backendId} (session default model)`
    : `${target.backendId} model ${JSON.stringify(target.model)}`;
}

async function probeHarnessConfigOptions(
  calls: ValidatedAgentCall[],
  cwd: string,
  registry: BackendRegistry,
  hostRegistry: BackendRegistry,
  declared: Record<string, CustomBackendConfig> | undefined,
  warnings: string[],
  probeRunner: ValidateProbeRunner | undefined,
  probeTimeoutMs: number,
): Promise<ProbeStageResult> {
  const targets = configProbeTargets(calls, registry, hostRegistry, declared);
  const harnessOptions: ValidateHarnessOptions[] = [];
  const catalogs = new Map<string, SessionConfigOption[]>();
  const modes = new Map<string, SessionModeState | null>();
  if (targets.length === 0) return { harnessOptions, catalogs, modes };

  let runner: ValidateProbeRunner;
  const ownsRunner = probeRunner === undefined;
  try {
    runner = probeRunner ?? createValidateProbeRunner(registryOptions(registry));
  } catch (error) {
    const reason = errorMessage(error);
    for (const target of targets) {
      warnings.push(
        `could not probe ${probeTargetName(target)} — configOptions on its calls are unverified: ${reason}`,
      );
      harnessOptions.push({
        backendId: target.backendId,
        ...(target.model === undefined ? {} : { model: target.model }),
        probed: false,
        error: reason,
      });
    }
    return { harnessOptions, catalogs, modes };
  }

  try {
    const failures = new Map<string, string>();
    const probeTarget = async (
      target: ConfigProbeTarget,
      reportHarness: boolean,
    ): Promise<SessionConfigOption[] | undefined> => {
      const key = configCatalogKey(target.backendId, target.model);
      const cached = catalogs.get(key);
      if (cached) return cached;
      if (failures.has(key)) return undefined;
      try {
        const result = await withValidationProbeTimeout(
          (signal) => runner.probeConfigOptions(target.model ?? target.backendId, {
            cwd,
            selectModel: target.model !== undefined,
            backends: declared,
            signal,
          }),
          probeTimeoutMs,
        );
        catalogs.set(key, result.options);
        modes.set(key, result.modes ?? null);
        if (reportHarness) {
          harnessOptions.push({
            backendId: result.backendId,
            ...(target.model === undefined ? {} : { model: target.model }),
            probed: true,
            modes: result.modes ?? null,
            options: result.options,
          });
        }
        return result.options;
      } catch (error) {
        const reason = errorMessage(error);
        failures.set(key, reason);
        if (reportHarness) {
          warnings.push(
            `could not probe ${probeTargetName(target)} — configOptions on its calls are unverified: ${reason}`,
          );
          harnessOptions.push({
            backendId: target.backendId,
            ...(target.model === undefined ? {} : { model: target.model }),
            probed: false,
            error: reason,
          });
        }
        return undefined;
      }
    };

    for (const target of targets) await probeTarget(target, true);

    const orderedTargets = new Map<string, ConfigProbeTarget[]>();
    for (const target of targets) {
      if (target.thoughtLevelDomainSemantics !== "ordered") continue;
      const catalog = catalogs.get(configCatalogKey(target.backendId, target.model));
      if (!catalog?.some((option) =>
        isThoughtLevelSelect(option) &&
        recognizedSelectValues(option, selectChoiceValues(option)) === undefined
      )) continue;
      const backendTargets = orderedTargets.get(target.backendId) ?? [];
      backendTargets.push(target);
      orderedTargets.set(target.backendId, backendTargets);
    }
    for (const [backendId, backendTargets] of orderedTargets) {
      await enumerateOrderedThoughtLevelDomains(
        backendId,
        backendTargets,
        catalogs,
        probeTarget,
        warnings,
      );
    }
  } finally {
    if (ownsRunner) {
      try {
        await runner.dispose?.();
      } catch {
        // Probe results are complete; process cleanup must not change validation semantics.
      }
    }
  }
  return { harnessOptions, catalogs, modes };
}

function withValidationProbeTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`config probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    operation(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isThoughtLevelSelect(
  option: SessionConfigOption,
): option is Extract<SessionConfigOption, { type: "select" }> {
  return option.type === "select" &&
    (option.category === "thought_level" || option.id === "thinkingLevel");
}

const NON_ORDERED_THOUGHT_LEVEL_SENTINELS = new Set(["default"]);

async function enumerateOrderedThoughtLevelDomains(
  backendId: string,
  targets: readonly ConfigProbeTarget[],
  catalogs: Map<string, SessionConfigOption[]>,
  probeTarget: (
    target: ConfigProbeTarget,
    reportHarness: boolean,
  ) => Promise<SessionConfigOption[] | undefined>,
  warnings: string[],
): Promise<void> {
  const seedCatalogs = targets.flatMap((target) => {
    const catalog = catalogs.get(configCatalogKey(target.backendId, target.model));
    return catalog ? [catalog] : [];
  });
  const modelOption = seedCatalogs
    .flatMap((catalog) => catalog)
    .find((option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.type === "select" && option.id === "model"
    );
  if (!modelOption) {
    warnings.push(
      `skipped ordered thought-level domain enumeration for ${backendId}: no advertised model select option; ` +
        "using exact advertised-value validation",
    );
    return;
  }

  const models = [...new Set(selectChoiceValues(modelOption))];
  if (models.length > ORDERED_THOUGHT_LEVEL_ENUMERATION_MODEL_LIMIT) {
    warnings.push(
      `skipped ordered thought-level domain enumeration for ${backendId}: advertised ${models.length} models, ` +
        `above the limit of ${ORDERED_THOUGHT_LEVEL_ENUMERATION_MODEL_LIMIT}; using exact advertised-value validation`,
    );
    return;
  }
  if (models.length === 0) {
    warnings.push(
      `skipped ordered thought-level domain enumeration for ${backendId}: the advertised model select has no values; ` +
        "using exact advertised-value validation",
    );
    return;
  }

  const orderedSubsets = new Map<string, string[][]>();
  const sentinels = new Map<string, string[]>();
  for (const model of models) {
    const modelSpec = `${backendId}/${model}`;
    const catalog = await probeTarget({
      backendId,
      model: modelSpec,
      thoughtLevelDomainSemantics: "ordered",
    }, false);
    if (!catalog) {
      warnings.push(
        `could not complete ordered thought-level domain enumeration for ${backendId}: ` +
          `model ${JSON.stringify(model)} could not be probed; using exact advertised-value validation`,
      );
      return;
    }
    for (const option of catalog) {
      if (!isThoughtLevelSelect(option)) continue;
      const values = selectChoiceValues(option);
      const ordered = values.filter((value) => !NON_ORDERED_THOUGHT_LEVEL_SENTINELS.has(value));
      const optionSentinels = values.filter((value) => NON_ORDERED_THOUGHT_LEVEL_SENTINELS.has(value));
      const subsets = orderedSubsets.get(option.id) ?? [];
      subsets.push(ordered);
      orderedSubsets.set(option.id, subsets);
      const knownSentinels = sentinels.get(option.id) ?? [];
      for (const sentinel of optionSentinels) {
        if (!knownSentinels.includes(sentinel)) knownSentinels.push(sentinel);
      }
      sentinels.set(option.id, knownSentinels);
    }
  }

  const recognizedByOption = new Map<string, string[]>();
  for (const [optionId, subsets] of orderedSubsets) {
    const ordered = mergeOrderedSubsets(subsets);
    if (!ordered) {
      warnings.push(
        `could not merge advertised thought-level orders for ${backendId} option ${JSON.stringify(optionId)}; ` +
          "using exact advertised-value validation",
      );
      return;
    }
    const recognized = [...ordered, ...(sentinels.get(optionId) ?? [])];
    if (recognized.length > 0) recognizedByOption.set(optionId, recognized);
  }
  attachClientRecognizedDomains(catalogs, backendId, recognizedByOption);
}

function mergeOrderedSubsets(subsets: readonly (readonly string[])[]): string[] | undefined {
  const firstSeen = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const subset of subsets) {
    const unique = [...new Set(subset)];
    for (const value of unique) {
      if (!firstSeen.has(value)) firstSeen.set(value, firstSeen.size);
      if (!outgoing.has(value)) outgoing.set(value, new Set());
      if (!indegree.has(value)) indegree.set(value, 0);
    }
    for (let index = 1; index < unique.length; index++) {
      const before = unique[index - 1];
      const after = unique[index];
      if (before === undefined || after === undefined) continue;
      const edges = outgoing.get(before)!;
      if (edges.has(after)) continue;
      edges.add(after);
      indegree.set(after, (indegree.get(after) ?? 0) + 1);
    }
  }

  const ready = [...indegree]
    .filter(([, count]) => count === 0)
    .map(([value]) => value);
  const compare = (left: string, right: string) =>
    (firstSeen.get(left) ?? 0) - (firstSeen.get(right) ?? 0) || left.localeCompare(right);
  ready.sort(compare);
  const merged: string[] = [];
  while (ready.length > 0) {
    const value = ready.shift()!;
    merged.push(value);
    for (const after of outgoing.get(value) ?? []) {
      const remaining = (indegree.get(after) ?? 0) - 1;
      indegree.set(after, remaining);
      if (remaining === 0) {
        ready.push(after);
        ready.sort(compare);
      }
    }
  }
  return merged.length === indegree.size ? merged : undefined;
}

function attachClientRecognizedDomains(
  catalogs: Map<string, SessionConfigOption[]>,
  backendId: string,
  recognizedByOption: ReadonlyMap<string, readonly string[]>,
): void {
  for (const [key, catalog] of catalogs) {
    const [catalogBackend] = JSON.parse(key) as [string, string | null];
    if (catalogBackend !== backendId) continue;
    for (const option of catalog) {
      if (!isThoughtLevelSelect(option)) continue;
      const supported = selectChoiceValues(option);
      if (recognizedSelectValues(option, supported)) continue;
      const recognized = recognizedByOption.get(option.id);
      if (!recognized || !supported.every((value) => recognized.includes(value))) continue;
      const meta = option._meta && typeof option._meta === "object" && !Array.isArray(option._meta)
        ? option._meta
        : {};
      const existingNamespace = meta[CONFIG_OPTION_META_NAMESPACE];
      const namespace = existingNamespace &&
          typeof existingNamespace === "object" &&
          !Array.isArray(existingNamespace)
        ? existingNamespace as Record<string, unknown>
        : {};
      option._meta = {
        ...meta,
        [CONFIG_OPTION_META_NAMESPACE]: {
          ...namespace,
          recognizedValues: [...recognized],
        },
      };
    }
  }
}

function errorMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error)).value;
}

function sessionModeErrors(
  calls: ValidatedAgentCall[],
  modes: Map<string, SessionModeState | null>,
  registry: BackendRegistry,
  hostRegistry: BackendRegistry,
  declared: Record<string, CustomBackendConfig> | undefined,
): string[] {
  const errors: string[] = [];
  for (const call of calls) {
    if (call.mode === undefined) continue;
    const backendId = routeBackend(call.model, call.tier, registry, hostRegistry, declared).backendId;
    const key = configCatalogKey(backendId, call.model);
    if (!modes.has(key)) continue;
    const advertised = modes.get(key)?.availableModes.map((mode) => mode.id) ?? [];
    if (advertised.includes(call.mode)) continue;
    errors.push(
      `agent "${call.label}" mode authored value ${JSON.stringify(call.mode)} is not advertised by ` +
        `${callModelName(backendId, call.model)}; advertised modes: ${displayAlternatives(advertised)}; ` +
        "omit mode unless action:\"config\" explicitly lists the exact id",
    );
  }
  return errors;
}

function configOptionErrors(
  calls: ValidatedAgentCall[],
  catalogs: Map<string, SessionConfigOption[]>,
  registry: BackendRegistry,
  hostRegistry: BackendRegistry,
  declared: Record<string, CustomBackendConfig> | undefined,
  warnings: string[],
): string[] {
  const errors: string[] = [];
  for (const call of calls) {
    if (!call.configOptions || Object.keys(call.configOptions).length === 0) continue;
    const backendId = routeBackend(call.model, call.tier, registry, hostRegistry, declared).backendId;
    const advertised = catalogs.get(configCatalogKey(backendId, call.model));
    if (!advertised) continue;
    const optionIds = advertised.map((option) => option.id);
    for (const [id, value] of Object.entries(call.configOptions as Record<string, unknown>)) {
      const authored = displayValue(value);
      if (id === "model") {
        errors.push(
          `agent "${call.label}" configOptions option "model" authored value ${authored} is reserved; ` +
            `advertised alternatives: use the call's model field; option ids ${displayAlternatives(optionIds)}`,
        );
        continue;
      }
      const option = advertised.find((candidate) => candidate.id === id);
      if (!option) {
        errors.push(
          `agent "${call.label}" configOptions option ${JSON.stringify(id)} authored value ${authored} is unknown; ` +
            `advertised alternatives: option ids ${displayAlternatives(optionIds)}`,
        );
        continue;
      }
      if (option.type === "select") {
        const choices = selectChoiceValues(option);
        if (typeof value !== "string") {
          errors.push(
            `agent "${call.label}" configOptions option ${JSON.stringify(id)} authored value ${authored} is not an advertised select value; ` +
              `advertised alternatives: ${displayAlternatives(choices)}`,
          );
          continue;
        }
        if (choices.includes(value)) continue;

        const recognized = recognizedSelectValues(option, choices);
        if (recognized) {
          if (!recognized.includes(value)) {
            errors.push(
              `agent "${call.label}" configOptions option ${JSON.stringify(id)} authored value ${authored} is not recognized for ` +
                `${callModelName(backendId, call.model)}; valid values: ${displayAlternatives(recognized)}`,
            );
            continue;
          }
          const effective = clampSelectValue(value, choices, recognized);
          if (effective !== undefined) {
            warnings.push(
              `agent "${call.label}" configOptions option ${JSON.stringify(id)} value ${authored} is unsupported by ` +
                `${callModelName(backendId, call.model)} and will clamp to ${JSON.stringify(effective)}; ` +
                `supported values: ${displayAlternatives(choices)}`,
            );
            continue;
          }
          errors.push(
            `agent "${call.label}" configOptions option ${JSON.stringify(id)} authored value ${authored} cannot clamp for ` +
              `${callModelName(backendId, call.model)} because it advertises no supported values`,
          );
          continue;
        }

        if (isThoughtLevelSelect(option)) {
          errors.push(
            `agent "${call.label}" configOptions option ${JSON.stringify(id)} authored value ${authored} is not advertised by ` +
              `${callModelName(backendId, call.model)}; advertised alternatives: ${displayAlternatives(choices)}; ` +
              "no recognized ordered domain is available, so the value must match exactly",
          );
        } else {
          errors.push(
            `agent "${call.label}" configOptions option ${JSON.stringify(id)} authored value ${authored} is not an advertised select value; ` +
              `advertised alternatives: ${displayAlternatives(choices)}`,
          );
        }
        continue;
      }
      if (typeof value !== "boolean") {
        errors.push(
          `agent "${call.label}" configOptions option ${JSON.stringify(id)} authored value ${authored} must be boolean; ` +
            "advertised alternatives: true, false",
        );
      }
    }
  }
  return errors;
}

function callModelName(backendId: string, model: string | undefined): string {
  return model === undefined
    ? `${backendId} session default model`
    : `${backendId} model ${JSON.stringify(model)}`;
}

function recognizedSelectValues(
  option: Extract<SessionConfigOption, { type: "select" }>,
  supported: readonly string[],
): string[] | undefined {
  const namespace = option._meta?.[CONFIG_OPTION_META_NAMESPACE];
  if (namespace === null || typeof namespace !== "object" || Array.isArray(namespace)) return undefined;
  const values = (namespace as { recognizedValues?: unknown }).recognizedValues;
  if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === "string")) {
    return undefined;
  }
  const recognized = values as string[];
  if (new Set(recognized).size !== recognized.length || !supported.every((value) => recognized.includes(value))) {
    return undefined;
  }
  return recognized;
}

function clampSelectValue(
  requested: string,
  supported: readonly string[],
  recognized: readonly string[],
): string | undefined {
  if (supported.includes(requested)) return requested;
  const orderedRecognized = recognized.filter(
    (value) => !NON_ORDERED_THOUGHT_LEVEL_SENTINELS.has(value),
  );
  const requestedIndex = orderedRecognized.indexOf(requested);
  if (requestedIndex < 0) return undefined;
  for (let index = requestedIndex; index < orderedRecognized.length; index++) {
    const candidate = orderedRecognized[index];
    if (candidate !== undefined && supported.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index--) {
    const candidate = orderedRecognized[index];
    if (candidate !== undefined && supported.includes(candidate)) return candidate;
  }
  return undefined;
}

type SelectConfigOption = Extract<SessionConfigOption, { type: "select" }>;

function selectChoiceValues(option: SelectConfigOption): string[] {
  return option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry])).map((entry) => entry.value);
}

/** Every leaf {value,label} the select advertises, flattening any advertised optgroups. */
export function selectChoicePairs(option: SelectConfigOption): { value: string; label?: string }[] {
  return option.options
    .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    .map((entry) => ({ value: entry.value, label: entry.name }));
}

/**
 * Above this many advertised choices, a select's inline enumeration is replaced by a
 * grouped summary in every RENDERED surface — the human table AND `--json` — so a harness
 * with a huge model catalog (pi, opencode) cannot flood an agent's context on either flag.
 * The complete list stays in the in-memory report (validation reads it, SDK embedders get
 * it) and is reachable only through the explicit `config <harness> --models[=<filter>]`
 * path. Small catalogs — claude, codex, and every effort/mode/boolean option — stay under
 * this bound and render verbatim, unchanged.
 */
export const MAX_INLINE_SELECT_CHOICES = 24;

export interface SelectChoiceGroup {
  group: string;
  count: number;
}

export interface SelectChoiceSummary {
  total: number;
  groups: SelectChoiceGroup[];
}

/** The group a bare (ungrouped) choice value belongs to: its first "/"-segment
 *  (pi/opencode ids are "<provider>/<model>"); a value with no "/" is "(ungrouped)". */
function groupOfValue(value: string): string {
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash) : "(ungrouped)";
}

/**
 * Group a select's choices for summary display. Prefers the harness-advertised optgroup
 * labels; absent those, groups by the first "/"-segment of each value. Groups come back
 * largest-first, ties broken by first appearance.
 */
export function summarizeSelectChoices(option: SelectConfigOption): SelectChoiceSummary {
  const counts = new Map<string, number>();
  const order: string[] = [];
  const bump = (name: string, n: number): void => {
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + n);
  };
  const hasAdvertisedGroups = option.options.some((entry) => "options" in entry);
  for (const entry of option.options) {
    if ("options" in entry) bump(entry.name ?? entry.group, entry.options.length);
    else if (hasAdvertisedGroups) bump(groupOfValue(entry.value), 1); // stray leaf beside groups
    else bump(groupOfValue(entry.value), 1);
  }
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const groups = order
    .map((group) => ({ group, count: counts.get(group) ?? 0 }))
    .sort((a, b) => b.count - a.count || order.indexOf(a.group) - order.indexOf(b.group));
  return { total, groups };
}

/** A select whose leaf-choice count exceeds the inline bound — rendered as a summary. */
export function isOversizedSelect(option: SessionConfigOption): option is SelectConfigOption {
  return option.type === "select" && selectChoicePairs(option).length > MAX_INLINE_SELECT_CHOICES;
}

/** The collapsed choices-cell for an oversized select in the human option table. */
function summaryChoicesCell(option: SelectConfigOption, backendId: string): string {
  const { total, groups } = summarizeSelectChoices(option);
  const shown = groups.slice(0, 3).map((group) => `${group.group} (${group.count})`).join(", ");
  const more = groups.length > 3 ? ", …" : "";
  return (
    `${total} choices across ${groups.length} group(s): ${shown}${more} — ` +
    `list with \`config ${backendId} --models[=<filter>]\``
  );
}

function displayValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function displayAlternatives(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => JSON.stringify(value)).join(", ") : "(none advertised)";
}

/** The choices-cell text for a select: verbatim when small, summarized when oversized. */
function selectChoicesCell(option: SelectConfigOption, backendId: string): string {
  return isOversizedSelect(option)
    ? summaryChoicesCell(option, backendId)
    : displayAlternatives(selectChoiceValues(option));
}

/** A select option reshaped for SERIALIZED output (--json): the huge `options` leaf array
 *  is dropped in favor of a compact grouped summary. Every scalar field is preserved. */
export type CollapsedSelectOption = Omit<SelectConfigOption, "options"> & {
  truncated: true;
  choiceSummary: SelectChoiceSummary & { expand: string };
};

export type RenderedConfigOption = SessionConfigOption | CollapsedSelectOption;

export interface RenderedHarnessOptions extends Omit<ValidateHarnessOptions, "options"> {
  options?: RenderedConfigOption[];
}

function collapseSelectOption(option: SelectConfigOption, backendId: string): CollapsedSelectOption {
  const { options: _leaves, ...scalars } = option;
  return {
    ...scalars,
    truncated: true,
    choiceSummary: { ...summarizeSelectChoices(option), expand: `config ${backendId} --models=<filter>` },
  };
}

/**
 * Collapse each harness's oversized select options for serialized (`--json`) output — the
 * only place the full catalog would otherwise reach an agent's context through a machine
 * flag. Small options and every non-select option pass through untouched. Applied ONLY at
 * the CLI print boundary; the in-memory report keeps the complete catalog so validation
 * and programmatic `probeHarnessConfig()` callers are unaffected.
 */
export function collapseHarnessOptionsForOutput(
  harnesses: readonly ValidateHarnessOptions[] | undefined,
): RenderedHarnessOptions[] | undefined {
  if (!harnesses) return harnesses === undefined ? undefined : [];
  return harnesses.map((harness) => {
    if (!harness.options) return harness;
    return {
      ...harness,
      options: harness.options.map((option) =>
        isOversizedSelect(option) ? collapseSelectOption(option, harness.backendId) : option,
      ),
    };
  });
}

/**
 * Validate a workflow script: parse it, dry-run against a mock AgentRunner, then probe
 * each routed backend/model pair's advertised modes and config options. Never throws for an invalid script —
 * read `report.ok` / `report.exitCode`.
 */
export async function validateWorkflowScript(
  script: string,
  options: ValidateWorkflowOptions = {},
): Promise<ValidateWorkflowReport> {
  const mockAnswerState = options.mockAnswers === undefined ? undefined : normalizeMockAnswers(options.mockAnswers);
  const warnings: string[] = [];
  const probeTimeoutMs = options.probeTimeoutMs ?? 60_000;
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) {
    throw new TypeError("validateWorkflowScript: probeTimeoutMs must be a positive number");
  }

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

  const declaredBackends =
    meta.backends && Object.keys(meta.backends).length > 0
      ? (meta.backends as Record<string, CustomBackendConfig>)
      : undefined;
  const configuredHostRegistry = resolveBackendRegistry();
  const runnerCustomBackends =
    options.probeRunner?.listCustomBackends?.() ??
    (options.probeRunner?.listBackends?.() ?? []).filter(
      (name) => !BUILTIN_BACKEND_IDS.includes(name.toLowerCase() as typeof BUILTIN_BACKEND_IDS[number]),
    );
  const discoveredHostBackends = Object.fromEntries(
    runnerCustomBackends
      .map((name) => name.toLowerCase())
      .filter((name) => !configuredHostRegistry.has(name))
      .map((name) => [name, { command: "__host_owned_probe_runner__" }]),
  );
  const hostRegistry =
    Object.keys(discoveredHostBackends).length === 0
      ? configuredHostRegistry
      : resolveBackendRegistry(discoveredHostBackends);
  const backendRegistry = registryWithRunBackends(hostRegistry, declaredBackends);
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
  const mockMeta = new Map<
    string,
    {
      tier?: string;
      mode?: string;
      configOptions?: Record<string, string | boolean>;
      schema: boolean;
    }
  >();
  const runner = {
    async run(_prompt: string, runOptions: MockRunOptions = {}) {
      const label = runOptions.label ?? "";
      const metadata = {
        tier: runOptions.tier,
        mode: runOptions.mode,
        configOptions: runOptions.configOptions,
        schema: runOptions.schema !== undefined,
      };
      mockMeta.set(label, metadata);
      const pendingCall = mockAnswerState ? pendingAgentCalls.shift() : undefined;
      if (pendingCall) {
        pendingCall.tier = metadata.tier;
        pendingCall.mode = metadata.mode;
        pendingCall.configOptions = metadata.configOptions;
        pendingCall.schema = metadata.schema;
        pendingCall.backend = routeBackend(
          pendingCall.model,
          metadata.tier,
          backendRegistry,
          hostRegistry,
          declaredBackends,
        ).display;
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
    loadSavedWorkflow: options.loadSavedWorkflow ?? flows?.resolve,
  });
  manager.on("agentStart", (event: {
    label: string;
    phase?: string;
    model?: string;
    configOptions?: Record<string, string | boolean>;
  }) => {
    const extra = mockMeta.get(event.label) ?? mockMeta.get("") ?? { schema: false };
    const call: ValidatedAgentCall = {
      label: event.label,
      phase: event.phase,
      model: event.model,
      tier: extra.tier,
      mode: extra.mode,
      configOptions: event.configOptions ?? extra.configOptions,
      backend: routeBackend(event.model, extra.tier, backendRegistry, hostRegistry, declaredBackends).display,
      schema: extra.schema,
    };
    agentCalls.push(call);
    if (mockAnswerState) pendingAgentCalls.push(call);
  });

  try {
    const run = await manager.runSync(script, options.args, {
      journaling: false,
      signal: controller.signal,
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
          call.configOptions = extra.configOptions;
          call.schema = extra.schema;
          call.backend = routeBackend(
            call.model,
            extra.tier,
            backendRegistry,
            hostRegistry,
            declaredBackends,
          ).display;
        }
      }
    }

    const runOk = run.status === "completed";
    if (!runOk && flows === undefined && run.reason?.includes("must be the first statement") && /\bworkflow\s*\(/.test(script)) {
      warnings.push(
        'the failure looks like a nested workflow("<name>") call on a bare name — provide workflow dirs ' +
          "(ValidateWorkflowOptions.workflows / --workflows-dir) so names resolve during the dry run",
      );
    }
    if (runOk) {
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
    const probed = await probeHarnessConfigOptions(
      agentCalls,
      baseCwd,
      backendRegistry,
      hostRegistry,
      declaredBackends,
      warnings,
      options.probeRunner,
      probeTimeoutMs,
    );
    const optionErrors = configOptionErrors(
      agentCalls,
      probed.catalogs,
      backendRegistry,
      hostRegistry,
      declaredBackends,
      warnings,
    );
    const modeErrors = sessionModeErrors(
      agentCalls,
      probed.modes,
      backendRegistry,
      hostRegistry,
      declaredBackends,
    );
    const configurationErrors = [...modeErrors, ...optionErrors];
    const ok = runOk && configurationErrors.length === 0;
    const runReason = timedOut ? `dry run exceeded ${timeoutMs}ms and was aborted` : run.reason;
    const reason =
      configurationErrors.length === 0
        ? runReason
        : [runReason, "agent configuration validation failed:", ...configurationErrors.map((error) => `- ${error}`)]
            .filter(Boolean)
            .join("\n");

    return {
      ok,
      exitCode: ok ? 0 : 2,
      parse: { ok: true, meta },
      dryRun: {
        ok,
        status: run.status,
        reason,
        timedOut,
        agentCalls,
        checkpoints,
        phasesVisited: run.phases ?? [],
        logs: run.logs ?? [],
        durationMs: run.durationMs,
        harnessOptions: probed.harnessOptions,
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

/** Render the per-harness advertised config-option tables, one indent level below the
 *  given prefix. Shared verbatim between the validate report and `agentprism-workflows
 *  config` (./config.ts) so the two commands' tables never drift. */
export function renderHarnessOptionLines(
  harnesses: readonly ValidateHarnessOptions[],
  indent: string,
): string[] {
  const lines: string[] = [];
  for (const harness of harnesses) {
    const target = harness.model === undefined
      ? harness.backendId
      : `${harness.backendId} (model ${JSON.stringify(harness.model)})`;
    if (!harness.probed) {
      lines.push(`${indent}${target}: probe failed — ${harness.error ?? "unknown error"}`);
      continue;
    }
    lines.push(`${indent}${target}:`);
    const modes = harness.modes;
    if (modes === null) {
      lines.push(`${indent}  modes: (none advertised — omit mode)`);
    } else if (modes === undefined) {
      lines.push(`${indent}  modes: (catalog unavailable — omit mode)`);
    } else {
      lines.push(
        `${indent}  modes: current ${displayValue(modes.currentModeId)} | advertised ` +
          displayAlternatives(modes.availableModes.map((mode) => mode.id)),
      );
    }
    lines.push(`${indent}  config options:`);
    lines.push(`${indent}  id | type | current | choices`);
    if ((harness.options ?? []).length === 0) {
      lines.push(`${indent}  (none advertised)`);
      continue;
    }
    for (const option of harness.options ?? []) {
      const choices = option.type === "select" ? selectChoicesCell(option, harness.backendId) : "true, false";
      lines.push(
        `${indent}  ${option.id} | ${option.type} | ${displayValue(option.currentValue)} | ${choices}`,
      );
    }
  }
  return lines;
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
    lines.push("    advertised modes and config options:");
    lines.push(...renderHarnessOptionLines(dry.harnessOptions ?? [], "      "));
    if ((dry.harnessOptions ?? []).length === 0) lines.push("      (no routed harnesses)");
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
