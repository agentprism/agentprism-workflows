// typebox/JSON-Schema -> the two on-the-wire shapes the backends need.
//
// CRITICAL (resume identity): the engine JSON.stringify's the EXACT typebox schema object
// into hashAgentCall (workflow.ts:1062), so the schema that feeds the resume hash MUST NOT
// be mutated. Both helpers below DEEP-CLONE via a JSON round-trip (which also strips
// typebox's internal Symbol-keyed metadata, leaving a clean JSON Schema) and only ever
// touch the copy. The original opts.schema reference is never written to.
import type { TSchema } from "typebox";

/** Deep-clone a typebox schema into a plain JSON Schema object (prompt embedding / MCP tool
 *  inputSchema — surfaces with no provider-side keyword restrictions). */
export function toJsonSchema(schema: TSchema): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

// JSON-Schema keywords Anthropic structured outputs REJECTS with a 400 (numeric/string/array
// constraints, composition/annotation keywords outside its supported subset). Stripped on the
// COPY sent as Claude's `outputFormat.schema`; the ORIGINAL schema still backs the client-side
// typebox validation, so a stripped constraint is enforced there instead of on the wire.
const ANTHROPIC_UNSUPPORTED_KEYWORDS = new Set<string>([
  "$schema",
  "$id",
  "title",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
  "patternProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

// The only `format` values Anthropic structured outputs accepts; any other value is a 400.
const ANTHROPIC_SUPPORTED_FORMATS = new Set<string>([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

// Regex features Anthropic's `pattern` support excludes: backreferences, lookaround, word
// boundaries. A pattern using any of these is dropped from the wire copy (typebox still
// enforces it client-side) rather than risking a 400 that silently disables the constraint.
const ANTHROPIC_UNSUPPORTED_REGEX = /\\[1-9]|\(\?<?[=!]|\\[bB]/;

/** Keys whose value is a NAME -> subschema map: the names are data, not JSON-Schema keywords,
 *  so keyword filtering must not apply to them (a property literally named "format" survives). */
const SCHEMA_MAP_KEYS = new Set<string>(["properties", "$defs", "definitions"]);

function normalizeSchemaMap(value: unknown, normalize: (node: unknown) => unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
    out[name] = normalize(sub);
  }
  return out;
}

function normalizeAnthropicNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeAnthropicNode);
  if (node === null || typeof node !== "object") return node;

  const input = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SCHEMA_MAP_KEYS.has(key)) {
      out[key] = normalizeSchemaMap(value, normalizeAnthropicNode);
      continue;
    }
    if (ANTHROPIC_UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === "minItems") {
      // Supported only for the values 0 and 1; anything larger is a 400.
      if (value === 0 || value === 1) out[key] = value;
      continue;
    }
    if (key === "format") {
      if (typeof value === "string" && ANTHROPIC_SUPPORTED_FORMATS.has(value)) out[key] = value;
      continue;
    }
    if (key === "pattern") {
      if (typeof value === "string" && !ANTHROPIC_UNSUPPORTED_REGEX.test(value)) out[key] = value;
      continue;
    }
    // `oneOf` is not in Anthropic's supported subset; its branches are an exclusive subset of
    // anyOf, so mapping over only widens acceptance — typebox re-narrows client-side.
    const targetKey = key === "oneOf" ? "anyOf" : key;
    out[targetKey] = normalizeAnthropicNode(value);
  }

  // Anthropic REQUIRES additionalProperties:false on EVERY object (true / a subschema / absent
  // are all 400s). Unlike OpenAI strict, `required` is left as authored — Anthropic allows
  // optional properties, so no all-required forcing and no null-widening here.
  const properties = out["properties"];
  const isObjectSchema =
    out["type"] === "object" || (out["type"] === undefined && properties !== undefined);
  if (isObjectSchema) out["additionalProperties"] = false;
  return out;
}

/**
 * Deep-clone a typebox schema and normalize it to the subset Anthropic structured outputs
 * accepts (Claude `outputFormat.schema`): additionalProperties:false on every object,
 * unsupported validation keywords / formats / regex features stripped, oneOf -> anyOf.
 * Authored `required` is preserved (optional properties stay optional). Without this, an
 * Anthropic-incompatible schema makes the SDK's native constraint fail and the run silently
 * degrades to unconstrained text + the repair ladder. Operates on the clone only — the schema
 * that feeds hashAgentCall is never mutated.
 */
export function toAnthropicJsonSchema(schema: TSchema): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as unknown;
  return normalizeAnthropicNode(clone) as Record<string, unknown>;
}

// JSON-Schema keywords OpenAI strict structured output does NOT accept. Stripped on the
// COPY before sending to Codex (turn/start.outputSchema is sent in strict mode). Structural
// keywords (type/properties/items/enum/anyOf/oneOf/allOf/$ref/$defs/definitions/const/
// description/required/additionalProperties) are preserved.
const STRICT_UNSUPPORTED_KEYWORDS = new Set<string>([
  "$schema",
  "$id",
  "title",
  "default",
  "examples",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
  "patternProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

function normalizeStrictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeStrictNode);
  if (node === null || typeof node !== "object") return node;

  // OpenAI strict rejects `allOf` (composition). Flatten the trivial object-merge case;
  // anything non-trivial throws a clear schema error rather than silently shipping invalid
  // strict schema. Flattening happens BEFORE keyword processing so the merged node then
  // takes the normal object-schema path below.
  let input = node as Record<string, unknown>;
  if (input["allOf"] !== undefined) {
    input = flattenAllOf(input);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SCHEMA_MAP_KEYS.has(key)) {
      // name -> subschema maps: the names are data, never keyword-filtered (a property
      // literally named "format" or "title" must survive).
      out[key] = normalizeSchemaMap(value, normalizeStrictNode);
      continue;
    }
    if (STRICT_UNSUPPORTED_KEYWORDS.has(key)) continue;
    // OpenAI strict accepts `anyOf` but not `oneOf` — map it over (its branches are an
    // exclusive subset of anyOf, so this only widens acceptance, never the validated set
    // beyond what the client-side typebox Check re-narrows).
    const targetKey = key === "oneOf" ? "anyOf" : key;
    out[targetKey] = normalizeStrictNode(value);
  }

  // OpenAI strict rule: every object must set additionalProperties:false and list EVERY
  // property in `required`. Treat a node as an object schema when it declares properties
  // (type may be "object" or omitted by some generators).
  const properties = out["properties"];
  const isObjectSchema =
    out["type"] === "object" || (out["type"] === undefined && properties !== undefined);
  if (isObjectSchema && properties !== null && typeof properties === "object") {
    const propObj = properties as Record<string, unknown>;
    const keys = Object.keys(propObj);
    // Forcing all-required would make originally-OPTIONAL props un-omittable. Keep them
    // expressible by unioning their type with "null" — the model may emit null for "absent".
    // Optionality is read from the node's ORIGINAL `required` (before we overwrite it).
    const originallyRequired = new Set(toStringArray(input["required"]));
    for (const key of keys) {
      if (!originallyRequired.has(key)) propObj[key] = makeNullable(propObj[key]);
    }
    out["additionalProperties"] = false;
    out["required"] = keys;
  }
  return out;
}

/** Pick out the string members of a JSON-Schema `required` array (tolerating junk). */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Make a (already strict-normalized) property schema accept `null`, so an originally-optional
 * field stays expressible once strict mode forces it into `required`:
 *   - a union (`anyOf`): add a `{ type: "null" }` branch if absent;
 *   - a string `type`: widen to `[type, "null"]`;
 *   - an array `type`: append "null" if absent;
 *   - anything else (a bare `$ref`, an empty schema, etc.): wrap in `anyOf:[schema,{null}]`.
 */
function makeNullable(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const node = schema as Record<string, unknown>;

  if (Array.isArray(node["anyOf"])) {
    const branches = node["anyOf"] as unknown[];
    if (!branches.some(isNullTypeSchema)) branches.push({ type: "null" });
    return node;
  }

  const type = node["type"];
  if (typeof type === "string") {
    if (type !== "null") node["type"] = [type, "null"];
    return node;
  }
  if (Array.isArray(type)) {
    if (!type.includes("null")) (type as unknown[]).push("null");
    return node;
  }

  // No `type` and no `anyOf` to widen (e.g. a bare `$ref`): wrap it in a nullable union.
  return { anyOf: [node, { type: "null" }] };
}

function isNullTypeSchema(node: unknown): boolean {
  return (
    node !== null && typeof node === "object" && (node as Record<string, unknown>)["type"] === "null"
  );
}

/**
 * Flatten an `allOf` node into a single object schema for OpenAI strict mode (which rejects
 * `allOf`). Only the TRIVIAL case is supported: every member (plus any sibling keywords on the
 * node itself) is an object schema, so their `properties`/`required` merge into one object.
 * Any member that is a non-object schema (a scalar/array constraint, a `$ref`, etc.) cannot be
 * trivially merged and throws a clear error — the caller must rewrite the schema without
 * `allOf` for strict structured output.
 */
function flattenAllOf(node: Record<string, unknown>): Record<string, unknown> {
  const allOf = node["allOf"];
  if (!Array.isArray(allOf)) {
    throw new Error('OpenAI strict schema: "allOf" must be an array to be flattened.');
  }
  const { allOf: _drop, ...siblings } = node;
  const parts: unknown[] = [siblings, ...allOf];

  const mergedProps: Record<string, unknown> = {};
  const mergedRequired: string[] = [];
  const merged: Record<string, unknown> = {};
  let sawProperties = false;

  for (const part of parts) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      throw new Error('OpenAI strict schema: cannot flatten an "allOf" whose member is not an object schema.');
    }
    let p = part as Record<string, unknown>;
    if (p["allOf"] !== undefined) p = flattenAllOf(p); // recurse into nested allOf first

    const props = p["properties"];
    const hasProps = props !== null && typeof props === "object" && !Array.isArray(props);
    const type = p["type"];
    const objectLike = hasProps || type === "object" || type === undefined;
    if (!objectLike) {
      throw new Error(
        `OpenAI strict schema: cannot flatten "allOf" containing a non-object subschema (type: ${JSON.stringify(
          type,
        )}); rewrite the schema without allOf for strict structured output.`,
      );
    }
    if (hasProps) {
      sawProperties = true;
      Object.assign(mergedProps, props as Record<string, unknown>);
    }
    mergedRequired.push(...toStringArray(p["required"]));
    for (const [key, value] of Object.entries(p)) {
      if (key === "properties" || key === "required" || key === "type") continue;
      merged[key] = value;
    }
  }
  if (!sawProperties) {
    throw new Error('OpenAI strict schema: "allOf" had no object subschemas to flatten.');
  }
  merged["type"] = "object";
  merged["properties"] = mergedProps;
  merged["required"] = [...new Set(mergedRequired)];
  return merged;
}

/**
 * Deep-clone a typebox schema and normalize it to OpenAI STRICT rules (Codex
 * `turn/start.outputSchema`): every property required, additionalProperties:false,
 * unsupported validation keywords stripped. Operates on the clone only — the schema that
 * feeds hashAgentCall is never mutated.
 */
export function toStrictJsonSchema(schema: TSchema): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as unknown;
  return normalizeStrictNode(clone) as Record<string, unknown>;
}
