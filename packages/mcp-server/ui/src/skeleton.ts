// Static structure ("skeleton") of a workflow script: every agent()/checkpoint()/workflow()
// call site, phase() marker, parallel()/pipeline() group, loop, and quality-control primitive.
// Sites are keyed by the innermost component of the engine's structural call path
// ("line:column", body-relative), so runtime agentStart events join a site with one lookup.
// The body MUST be derived exactly like the engine derives it (parseWorkflowScript splices the
// `export const meta` statement out by character offsets), or positions will not match.
import { parse } from "acorn";

interface AnyNode {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
}

export interface SkeletonSite {
  kind: "agent" | "checkpoint" | "workflow" | "stdlib";
  /** Innermost call-path component: `${line}:${column + 1}` of the callee identifier start. */
  key: string;
  /** kind "stdlib" only: the helper's name. */
  helper?: string;
  /** Static prefix of the prompt (literal text, or leading quasi of a template). */
  promptPreview?: string;
  /** Static prefix of the options.label value, when literal. */
  labelPreview?: string;
  /** options.phase when a string literal. */
  phaseLiteral?: string;
  /** Number of runtime agents this one site is statically known to fan out into. */
  expectedInstances?: number;
}

export type SkeletonLoopMode = "loop" | "gate" | "loopUntilDry";
export type SkeletonPanelMode = "verify" | "judgePanel";

export type SkeletonNode =
  | { kind: "phase"; title?: string }
  | { kind: "site"; site: SkeletonSite }
  | {
      kind: "group";
      mode: "parallel" | "pipeline";
      children: SkeletonNode[];
      /** Pipeline only: children partitioned per stage argument, in stage order. */
      stages?: SkeletonNode[][];
      /** Fan-out width when the items argument is an array literal. */
      staticCount?: number;
    }
  | {
      kind: "loop";
      mode: SkeletonLoopMode;
      children: SkeletonNode[];
      /** Gate only: producer and validator lanes, in that order. */
      stages?: SkeletonNode[][];
      /** gate attempts or loopUntilDry maxRounds when statically known. */
      maxIterations?: number;
      /** loopUntilDry consecutiveEmpty when statically known. */
      consecutiveEmpty?: number;
    }
  | {
      kind: "panel";
      mode: SkeletonPanelMode;
      children: SkeletonNode[];
      /** verify reviewers or judgePanel judges per candidate. */
      members: number;
      /** judgePanel candidate count when its first argument is statically countable. */
      candidates?: number;
      /** verify acceptance ratio when literal. */
      threshold?: number;
      /** verify lens count when an array literal is supplied. */
      lenses?: number;
    };

export interface Skeleton {
  roots: SkeletonNode[];
  /** Workflow name from the leading meta literal, when statically readable. */
  name?: string;
  /** Every call site keyed by its innermost call-path component. */
  byKey: Map<string, SkeletonSite>;
}

const ACORN_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "module",
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  locations: true,
} as const;

/** The innermost component of an engine call path, used to look sites up in byKey. */
export function innermostKey(path: string): string {
  const first = path.indexOf("<");
  return first === -1 ? path : path.slice(0, first);
}

/**
 * Reproduce parseWorkflowScript's body derivation: the first statement (the meta export) is
 * spliced out by character offsets, everything else — including a leading comment and the
 * newline that followed the meta statement — is kept verbatim.
 */
export function spliceMetaForBody(script: string): string | undefined {
  let ast: AnyNode;
  try {
    ast = parse(script, ACORN_OPTIONS) as unknown as AnyNode;
  } catch {
    return undefined;
  }
  const first = (ast.body as AnyNode[] | undefined)?.[0];
  if (first?.type !== "ExportNamedDeclaration") return undefined;
  return script.slice(0, first.start) + script.slice(first.end);
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && typeof (value as AnyNode).type === "string";
}

function siteKey(callee: AnyNode): string | undefined {
  const start = callee.loc?.start;
  // V8 reports the callee start for plain identifier calls (the only shape the DSL globals
  // have); +1 converts acorn's 0-based column to V8's 1-based.
  return start === undefined ? undefined : `${start.line}:${start.column + 1}`;
}

function textPreview(node: AnyNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    const quasis = node.quasis as AnyNode[];
    const expressions = node.expressions as AnyNode[];
    const lead = (quasis[0]?.value as { cooked?: string } | undefined)?.cooked ?? "";
    return expressions.length > 0 ? `${lead}…` : lead;
  }
  return undefined;
}

function propertyName(property: AnyNode): string | undefined {
  if (property.type !== "Property" || property.computed === true) return undefined;
  const keyNode = property.key as AnyNode;
  return keyNode.type === "Identifier"
    ? (keyNode.name as string)
    : keyNode.type === "Literal"
      ? String(keyNode.value)
      : undefined;
}

function objectProperty(options: AnyNode | undefined, name: string): AnyNode | undefined {
  if (options?.type !== "ObjectExpression") return undefined;
  for (const property of options.properties as AnyNode[]) {
    if (propertyName(property) === name) return property.value as AnyNode;
  }
  return undefined;
}

function optionPreview(options: AnyNode | undefined, name: string): string | undefined {
  return textPreview(objectProperty(options, name));
}

function finiteNumber(node: AnyNode | undefined): number | undefined {
  if (node?.type !== "Literal" || typeof node.value !== "number" || !Number.isFinite(node.value)) {
    return undefined;
  }
  return node.value;
}

function positiveIntegerOption(
  options: AnyNode | undefined,
  name: string,
  fallback: number,
): number {
  const value = finiteNumber(objectProperty(options, name));
  return value === undefined ? fallback : Math.max(1, Math.floor(value));
}

function arrayLiteralCount(node: AnyNode | undefined): number | undefined {
  return node?.type === "ArrayExpression" ? (node.elements as unknown[]).length : undefined;
}

/** Fan-out width when statically knowable: an array literal, or `.map` on an array literal. */
function staticItemCount(items: AnyNode | undefined): number | undefined {
  if (items === undefined) return undefined;
  if (items.type === "ArrayExpression") return (items.elements as unknown[]).length;
  if (items.type === "CallExpression") {
    const callee = items.callee as AnyNode;
    if (
      callee.type === "MemberExpression" &&
      callee.computed !== true &&
      (callee.property as AnyNode).type === "Identifier" &&
      (callee.property as AnyNode).name === "map" &&
      (callee.object as AnyNode).type === "ArrayExpression"
    ) {
      return ((callee.object as AnyNode).elements as unknown[]).length;
    }
  }
  return undefined;
}

function workflowName(ast: AnyNode): string | undefined {
  const first = (ast.body as AnyNode[] | undefined)?.[0];
  if (first?.type !== "ExportNamedDeclaration") return undefined;
  const declaration = first.declaration as AnyNode | undefined;
  if (declaration?.type !== "VariableDeclaration") return undefined;
  const meta = (declaration.declarations as AnyNode[] | undefined)?.[0]?.init as AnyNode | undefined;
  return optionPreview(meta, "name");
}

const SITE_CALLEES = new Set(["agent", "checkpoint", "workflow"]);
/** Engine-side one-agent helper. verify/judgePanel get semantic panel containers below. */
const STDLIB_SITE_CALLEES = new Set(["completenessCheck"]);
const LOOP_STATEMENTS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

interface ExtractContext {
  byKey: Map<string, SkeletonSite>;
}

function registerSite(
  name: string,
  callee: AnyNode,
  args: AnyNode[],
  context: ExtractContext,
  expectedInstances?: number,
): SkeletonNode | undefined {
  const key = siteKey(callee);
  if (key === undefined) return undefined;
  const kind = SITE_CALLEES.has(name) ? (name as SkeletonSite["kind"]) : "stdlib";
  const site: SkeletonSite = { kind, key };
  if (kind === "stdlib") site.helper = name;
  const prompt = textPreview(args[0]);
  if (prompt !== undefined) site.promptPreview = prompt;
  const label = optionPreview(args[1], "label");
  if (label !== undefined) site.labelPreview = label;
  const phase = optionPreview(args[1], "phase");
  if (phase !== undefined) site.phaseLiteral = phase;
  if (expectedInstances !== undefined) site.expectedInstances = expectedInstances;
  context.byKey.set(key, site);
  return { kind: "site", site };
}

function extractInto(node: unknown, out: SkeletonNode[], context: ExtractContext): void {
  if (Array.isArray(node)) {
    for (const child of node) extractInto(child, out, context);
    return;
  }
  if (!isNode(node)) return;

  if (LOOP_STATEMENTS.has(node.type)) {
    const children: SkeletonNode[] = [];
    extractInto(node.body, children, context);
    if (children.length > 0) out.push({ kind: "loop", mode: "loop", children });
    return;
  }

  if (node.type === "CallExpression") {
    const callee = node.callee as AnyNode;
    const args = node.arguments as AnyNode[];
    if (callee.type === "Identifier") {
      const name = callee.name as string;
      if (name === "phase") {
        const title = textPreview(args[0]);
        out.push(title === undefined ? { kind: "phase" } : { kind: "phase", title });
        return;
      }
      if (SITE_CALLEES.has(name) || STDLIB_SITE_CALLEES.has(name)) {
        const site = registerSite(name, callee, args, context);
        if (site !== undefined) out.push(site);
        // Arguments are prompt/data/options, not script thunks.
        return;
      }
      if (name === "verify") {
        const reviewers = positiveIntegerOption(args[1], "reviewers", 2);
        const site = registerSite(name, callee, args, context, reviewers);
        if (site !== undefined) {
          const threshold = finiteNumber(objectProperty(args[1], "threshold"));
          const lens = objectProperty(args[1], "lens");
          const lenses = arrayLiteralCount(lens) ?? (textPreview(lens) === undefined ? undefined : 1);
          out.push({
            kind: "panel",
            mode: "verify",
            children: [site],
            members: reviewers,
            ...(threshold === undefined ? {} : { threshold }),
            ...(lenses === undefined ? {} : { lenses }),
          });
        }
        return;
      }
      if (name === "judgePanel") {
        const judges = positiveIntegerOption(args[1], "judges", 3);
        const candidates = staticItemCount(args[0]);
        const expected = candidates === undefined ? undefined : judges * candidates;
        const site = registerSite(name, callee, args, context, expected);
        if (site !== undefined) {
          out.push({
            kind: "panel",
            mode: "judgePanel",
            children: [site],
            members: judges,
            ...(candidates === undefined ? {} : { candidates }),
          });
        }
        return;
      }
      if (name === "gate") {
        const producer: SkeletonNode[] = [];
        const validator: SkeletonNode[] = [];
        extractInto(args[0], producer, context);
        extractInto(args[1], validator, context);
        const children = [...producer, ...validator];
        if (children.length > 0) {
          out.push({
            kind: "loop",
            mode: "gate",
            children,
            stages: [producer, validator],
            maxIterations: positiveIntegerOption(args[2], "attempts", 3),
          });
        }
        return;
      }
      if (name === "loopUntilDry") {
        const children: SkeletonNode[] = [];
        const options = args[0];
        extractInto(objectProperty(options, "round"), children, context);
        if (children.length > 0) {
          out.push({
            kind: "loop",
            mode: "loopUntilDry",
            children,
            maxIterations: positiveIntegerOption(options, "maxRounds", 50),
            consecutiveEmpty: positiveIntegerOption(options, "consecutiveEmpty", 2),
          });
        }
        return;
      }
      if (name === "parallel") {
        const children: SkeletonNode[] = [];
        extractInto(args, children, context);
        const staticCount = staticItemCount(args[0]);
        out.push({
          kind: "group",
          mode: "parallel",
          children,
          ...(staticCount === undefined ? {} : { staticCount }),
        });
        return;
      }
      if (name === "pipeline") {
        const stages: SkeletonNode[][] = [];
        for (const stage of args.slice(1)) {
          const stageNodes: SkeletonNode[] = [];
          extractInto(stage, stageNodes, context);
          stages.push(stageNodes);
        }
        const children = stages.flat();
        const staticCount = staticItemCount(args[0]);
        out.push({
          kind: "group",
          mode: "pipeline",
          children,
          stages,
          ...(staticCount === undefined ? {} : { staticCount }),
        });
        return;
      }
    }
  }

  // Everything else — statements, expressions, function bodies (helpers contribute their
  // sites at the declaration's lexical position), if/try branches — descends transparently.
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const value = node[key];
    if (Array.isArray(value) || isNode(value)) extractInto(value, out, context);
  }
}

/**
 * Extract the structural skeleton of an admitted workflow script. Returns undefined when the
 * script cannot be parsed or has no leading meta export (callers fall back to the wave view).
 */
export function extractSkeleton(script: string): Skeleton | undefined {
  let sourceAst: AnyNode;
  try {
    sourceAst = parse(script, ACORN_OPTIONS) as unknown as AnyNode;
  } catch {
    return undefined;
  }
  const body = spliceMetaForBody(script);
  if (body === undefined) return undefined;
  let ast: AnyNode;
  try {
    ast = parse(body, ACORN_OPTIONS) as unknown as AnyNode;
  } catch {
    return undefined;
  }
  const context: ExtractContext = { byKey: new Map() };
  const roots: SkeletonNode[] = [];
  extractInto(ast.body, roots, context);
  const name = workflowName(sourceAst);
  return { roots, byKey: context.byKey, ...(name === undefined ? {} : { name }) };
}
