// Static structure ("skeleton") of a workflow script: every agent()/checkpoint()/workflow()
// call site, phase() markers, parallel()/pipeline() groups, and loop containers, extracted
// from the script text with acorn. Sites are keyed by the innermost component of the engine's
// structural call path ("line:column", body-relative), so runtime agentStart events join a
// site with a dictionary lookup. The body MUST be derived exactly like the engine derives it
// (parseWorkflowScript splices the `export const meta` statement out by character offsets);
// positions are computed on that spliced text or they will not match.
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
  /** kind "stdlib" only: the helper's name (verify / judgePanel / completenessCheck). */
  helper?: string;
  /** Static prefix of the prompt (literal text, or leading quasi of a template). */
  promptPreview?: string;
  /** Static prefix of the options.label value, when literal. */
  labelPreview?: string;
  /** options.phase when a string literal. */
  phaseLiteral?: string;
}

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
  | { kind: "loop"; children: SkeletonNode[] };

export interface Skeleton {
  roots: SkeletonNode[];
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

function optionPreview(options: AnyNode | undefined, name: string): string | undefined {
  if (options?.type !== "ObjectExpression") return undefined;
  for (const property of options.properties as AnyNode[]) {
    if (property.type !== "Property" || property.computed === true) continue;
    const keyNode = property.key as AnyNode;
    const keyName =
      keyNode.type === "Identifier"
        ? (keyNode.name as string)
        : keyNode.type === "Literal"
          ? String(keyNode.value)
          : undefined;
    if (keyName === name) return textPreview(property.value as AnyNode);
  }
  return undefined;
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

const SITE_CALLEES = new Set(["agent", "checkpoint", "workflow"]);
/** Engine-side agent-backed helpers: their agents' innermost VM stack frame is the helper's
 *  call site in the script (all engine frames are filtered from the call path), so the call
 *  becomes a fan-out site. `retry`/`gate` take SCRIPT thunks and stay transparent instead —
 *  their inner agent() calls carry their own positions. */
const STDLIB_SITE_CALLEES = new Set(["verify", "judgePanel", "completenessCheck"]);
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

function extractInto(node: unknown, out: SkeletonNode[], context: ExtractContext): void {
  if (Array.isArray(node)) {
    for (const child of node) extractInto(child, out, context);
    return;
  }
  if (!isNode(node)) return;

  if (LOOP_STATEMENTS.has(node.type)) {
    const children: SkeletonNode[] = [];
    extractInto(node.body, children, context);
    if (children.length > 0) out.push({ kind: "loop", children });
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
      if (SITE_CALLEES.has(name)) {
        const key = siteKey(callee);
        if (key !== undefined) {
          const site: SkeletonSite = { kind: name as SkeletonSite["kind"], key };
          const prompt = textPreview(args[0]);
          if (prompt !== undefined) site.promptPreview = prompt;
          const label = optionPreview(args[1], "label");
          if (label !== undefined) site.labelPreview = label;
          const phase = optionPreview(args[1], "phase");
          if (phase !== undefined) site.phaseLiteral = phase;
          out.push({ kind: "site", site });
          context.byKey.set(key, site);
        }
        // Arguments are the prompt/options; anything nested inside them is noise.
        return;
      }
      if (STDLIB_SITE_CALLEES.has(name)) {
        const key = siteKey(callee);
        if (key !== undefined) {
          const site: SkeletonSite = { kind: "stdlib", key, helper: name };
          const prompt = textPreview(args[0]);
          if (prompt !== undefined) site.promptPreview = prompt;
          out.push({ kind: "site", site });
          context.byKey.set(key, site);
        }
        // Arguments are data (claim/attempts/results), not script thunks.
        return;
      }
      if (name === "loopUntilDry") {
        // Engine-side loop over a SCRIPT round callback: the callback's agent sites carry
        // their own positions, and repeats page as iterations like a syntactic loop.
        const children: SkeletonNode[] = [];
        extractInto(args, children, context);
        if (children.length > 0) out.push({ kind: "loop", children });
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
  return { roots, byKey: context.byKey };
}
