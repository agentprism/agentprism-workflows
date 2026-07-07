// Area (1): typebox/JSON-Schema -> the two on-the-wire shapes, asserting the ORIGINAL
// (hash-feeding) schema object is NEVER mutated.
//
// The engine JSON.stringify's the EXACT typebox schema into the resume-identity hash
// (hashAgentCall), so both helpers must operate on a COPY only. We assert that with two
// independent checks per call: (a) JSON.stringify(schema) is byte-identical before/after
// (the hash input is stable), and (b) the specific fields a careless in-place normalizer
// would have clobbered are still present on the original.
import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { toAnthropicJsonSchema, toJsonSchema, toStrictJsonSchema } from "../src/index.js";

/** A structural view of a JSON-Schema node for reading runtime fields off either a plain
 *  output object or a typebox schema (which carries the same fields, just not in its static
 *  type). Going through `unknown` is the type-safe way to view these JSON values. */
interface JsonNode {
  type?: string;
  additionalProperties?: unknown;
  title?: unknown;
  required?: string[];
  properties?: Record<string, JsonNode>;
  items?: unknown;
  minLength?: number;
  format?: string;
  [k: string]: unknown;
}

const view = (value: unknown): JsonNode => value as JsonNode;

/** A schema that deliberately exercises every strict transformation:
 *  - top-level `additionalProperties: true` + `title` (an unsupported keyword)
 *  - a REQUIRED prop carrying unsupported validation keywords (minLength, format)
 *  - an OPTIONAL prop (NOT in typebox `required`) carrying `minimum`
 *  - a NESTED object that must itself get additionalProperties:false + full `required`
 *  - an array carrying `minItems` (unsupported) */
function buildSchema() {
  return Type.Object(
    {
      name: Type.String({ minLength: 1, format: "email", pattern: "^.+@.+$" }),
      age: Type.Optional(Type.Integer({ minimum: 0, maximum: 130 })),
      address: Type.Object({
        city: Type.String(),
        zip: Type.Optional(Type.String({ pattern: "\\d{5}" })),
      }),
      tags: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
    },
    { additionalProperties: true, title: "Person", $id: "person.schema" },
  );
}

test("toStrictJsonSchema: every property required + additionalProperties:false (incl. nested)", () => {
  const schema = buildSchema();
  const strict = toStrictJsonSchema(schema);

  assert.equal(strict.additionalProperties, false);
  // Optional `age` is FORCED into required by the strict normalizer.
  assert.deepEqual(strict.required, ["name", "age", "address", "tags"]);

  const props = strict.properties as Record<string, Record<string, unknown>>;
  // Nested object also normalized: additionalProperties:false + all of its props required.
  assert.equal(props.address.additionalProperties, false);
  assert.deepEqual(props.address.required, ["city", "zip"]);
});

test("toStrictJsonSchema: unsupported validation keywords are stripped on the copy", () => {
  const schema = buildSchema();
  const strict = toStrictJsonSchema(schema);
  const props = strict.properties as Record<string, Record<string, unknown>>;
  const address = props.address.properties as Record<string, Record<string, unknown>>;

  // top-level non-structural keywords gone
  assert.equal("title" in strict, false);
  assert.equal("$id" in strict, false);
  // string validators gone, but structural `type` kept
  assert.equal(props.name.type, "string");
  assert.equal("minLength" in props.name, false);
  assert.equal("format" in props.name, false);
  assert.equal("pattern" in props.name, false);
  // numeric validators gone
  assert.equal("minimum" in props.age, false);
  assert.equal("maximum" in props.age, false);
  // array validators gone, items kept
  assert.equal("minItems" in props.tags, false);
  assert.equal("uniqueItems" in props.tags, false);
  assert.deepEqual(props.tags.items, { type: "string" });
  // nested string validator gone
  assert.equal("pattern" in address.zip, false);
});

test("toStrictJsonSchema: does NOT mutate the original hash-feeding schema", () => {
  const schema = buildSchema();
  const hashBefore = JSON.stringify(schema);

  toStrictJsonSchema(schema);

  // (a) the exact bytes the resume hash consumes are unchanged
  assert.equal(JSON.stringify(schema), hashBefore);
  // (b) the fields an in-place normalizer would have clobbered are intact
  const original = view(schema);
  assert.equal(original.additionalProperties, true);
  assert.equal(original.title, "Person");
  assert.deepEqual(original.required, ["name", "address", "tags"]); // optional `age` still absent
  assert.equal(original.properties?.name?.minLength, 1);
  assert.equal(original.properties?.name?.format, "email");
});

test("toJsonSchema (Claude path): plain clone that PRESERVES validation keywords, no strict rules", () => {
  const schema = buildSchema();
  const json = toJsonSchema(schema);
  const props = json.properties as Record<string, Record<string, unknown>>;

  // Claude consumes the SDK's own native constraint, so we do NOT impose OpenAI-strict rules:
  assert.equal(json.additionalProperties, true); // original value preserved, not forced false
  assert.deepEqual(json.required, ["name", "address", "tags"]); // optional `age` NOT added
  assert.equal(props.name.minLength, 1); // validation keywords preserved
  assert.equal(props.name.format, "email");
  assert.equal((json as Record<string, unknown>).title, "Person");
});

test("both helpers strip typebox's internal (~kind) metadata via the JSON round-trip", () => {
  const schema = buildSchema();
  // typebox carries a non-enumerable `~kind` marker on every node; JSON.stringify drops it.
  assert.ok(Object.getOwnPropertyNames(schema).includes("~kind"));

  for (const out of [toJsonSchema(schema), toStrictJsonSchema(schema)]) {
    assert.equal(Object.getOwnPropertyNames(out).includes("~kind"), false);
    const props = out.properties as Record<string, Record<string, unknown>>;
    assert.equal(Object.getOwnPropertyNames(props.name).includes("~kind"), false);
  }
  // ...and the original still has it (we cloned, not stripped-in-place).
  assert.ok(Object.getOwnPropertyNames(schema).includes("~kind"));
});

test("toStrictJsonSchema: returned copy is independent — mutating it cannot reach the original", () => {
  const schema = buildSchema();
  const strict = toStrictJsonSchema(schema);
  (strict.properties as Record<string, unknown>).injected = { type: "string" };
  assert.equal("injected" in schema.properties, false);
});

// ---- (6) originally-OPTIONAL props become NULLABLE under all-required strict mode --------

test("toStrictJsonSchema: optional prop -> required AND nullable (type unioned with null)", () => {
  const schema = buildSchema();
  const strict = toStrictJsonSchema(schema);
  const props = strict.properties as Record<string, JsonNode>;

  // `age` was optional; strict forces it into `required`, so it must also accept null.
  assert.deepEqual(props.age.type, ["integer", "null"]);
  assert.ok((strict.required as string[]).includes("age"));

  // The nested optional `zip` is likewise required + nullable.
  const address = props.address.properties as Record<string, JsonNode>;
  assert.deepEqual(address.zip.type, ["string", "null"]);
  assert.deepEqual(props.address.required, ["city", "zip"]);

  // A REQUIRED prop is NOT made nullable (its type stays a bare string).
  assert.equal(props.name.type, "string");
  // A required array prop also stays non-nullable.
  assert.equal(props.tags.type, "array");
});

test("toStrictJsonSchema: optional nested OBJECT prop becomes nullable via its object type", () => {
  const schema = Type.Object({
    inner: Type.Optional(Type.Object({ c: Type.String() })),
    keep: Type.String(),
  });
  const strict = toStrictJsonSchema(schema);
  const props = strict.properties as Record<string, JsonNode>;
  // optional object -> required + type widened to ["object","null"]
  assert.deepEqual(props.inner.type, ["object", "null"]);
  assert.deepEqual(strict.required, ["inner", "keep"]);
  // the (now-nullable) nested object still got strict treatment internally
  assert.equal(props.inner.additionalProperties, false);
  assert.deepEqual(props.inner.required, ["c"]);
});

test("toStrictJsonSchema: optional $ref prop (no inline type) is wrapped in a nullable anyOf", () => {
  const schema = Type.Object(
    { a: Type.Optional(Type.Ref("Foo")), b: Type.String() },
    { $defs: { Foo: Type.Object({ z: Type.String() }) } },
  );
  const strict = toStrictJsonSchema(schema);
  const props = strict.properties as Record<string, JsonNode>;
  // No inline `type` to widen -> wrap the $ref in anyOf:[ {$ref}, {type:null} ].
  const anyOf = props.a.anyOf as JsonNode[];
  assert.ok(Array.isArray(anyOf));
  assert.equal(anyOf.length, 2);
  assert.equal((anyOf[0] as { $ref?: string }).$ref, "Foo");
  assert.deepEqual(anyOf[1], { type: "null" });
  assert.deepEqual(strict.required, ["a", "b"]);
});

// ---- (6) strict-UNSUPPORTED composition: allOf flattened or rejected; oneOf -> anyOf -----

test("toStrictJsonSchema: trivial allOf (Intersect of objects) is flattened into one object", () => {
  // Type.Intersect renders `{ allOf: [ {obj}, {obj} ] }` with no top-level type.
  const schema = Type.Intersect([
    Type.Object({ a: Type.String() }), // `a` required in its part
    Type.Object({ b: Type.Optional(Type.Number()) }), // `b` optional in its part
  ]);
  const strict = toStrictJsonSchema(schema);

  assert.equal("allOf" in strict, false, "allOf must be gone (OpenAI strict rejects it)");
  assert.equal(strict.type, "object");
  assert.equal(strict.additionalProperties, false);
  const props = strict.properties as Record<string, JsonNode>;
  // merged props; both forced required; the originally-optional `b` becomes nullable.
  assert.deepEqual(Object.keys(props), ["a", "b"]);
  assert.deepEqual(strict.required, ["a", "b"]);
  assert.equal(props.a.type, "string");
  assert.deepEqual(props.b.type, ["number", "null"]);
});

test("toStrictJsonSchema: a NON-object allOf member throws a clear schema error", () => {
  // allOf combining scalar constraints cannot be trivially flattened to one object schema.
  const schema = Type.Object({
    x: Type.Unsafe({ allOf: [{ type: "string" }, { type: "number" }] }),
  });
  assert.throws(() => toStrictJsonSchema(schema), /allOf/i);
});

test("toStrictJsonSchema: oneOf is rewritten to anyOf (OpenAI strict accepts anyOf only)", () => {
  const schema = Type.Object({
    choice: Type.Unsafe({ oneOf: [{ type: "string" }, { type: "number" }] }),
  });
  const strict = toStrictJsonSchema(schema);
  const props = strict.properties as Record<string, JsonNode>;
  assert.equal("oneOf" in props.choice, false);
  assert.deepEqual(props.choice.anyOf, [{ type: "string" }, { type: "number" }]);
});

test("toStrictJsonSchema: allOf/oneOf normalization does NOT mutate the hash-feeding original", () => {
  const schema = Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Optional(Type.Number()) })]);
  const before = JSON.stringify(schema);
  toStrictJsonSchema(schema);
  assert.equal(JSON.stringify(schema), before, "the exact bytes the resume hash consumes are unchanged");
  assert.ok(Array.isArray((view(schema) as JsonNode).allOf), "original still carries its allOf");
});

// ---- toAnthropicJsonSchema (Claude native outputFormat) ----------------------------------

test("toAnthropicJsonSchema: additionalProperties:false forced on EVERY object, required preserved", () => {
  const schema = buildSchema();
  const out = toAnthropicJsonSchema(schema);

  // Anthropic REQUIRES additionalProperties:false (authored `true` is a 400 as-is).
  assert.equal(out.additionalProperties, false);
  const props = out.properties as Record<string, JsonNode>;
  assert.equal(props.address.additionalProperties, false);
  // UNLIKE OpenAI strict: authored required survives — optional `age`/`zip` stay optional...
  assert.deepEqual(out.required, ["name", "address", "tags"]);
  assert.deepEqual(props.address.required, ["city"]);
  // ...and are NOT null-widened.
  assert.equal(props.age.type, "integer");
});

test("toAnthropicJsonSchema: unsupported keywords stripped; supported subset kept", () => {
  const schema = Type.Object({
    name: Type.String({ minLength: 1, format: "email", description: "the name" }),
    age: Type.Integer({ minimum: 0, maximum: 130, default: 30 }),
    tags: Type.Array(Type.String(), { minItems: 1, maxItems: 5, uniqueItems: true }),
    empties: Type.Array(Type.String(), { minItems: 0 }),
    status: Type.Unsafe({ type: "string", enum: ["a", "b"] }),
  }, { title: "Person", $id: "person" });
  const out = toAnthropicJsonSchema(schema);
  const props = out.properties as Record<string, JsonNode>;

  assert.equal("title" in out, false);
  assert.equal("$id" in out, false);
  // numeric/string constraints gone; description/default/enum kept
  assert.equal("minLength" in props.name, false);
  assert.equal(props.name.description, "the name");
  assert.equal("minimum" in props.age, false);
  assert.equal("maximum" in props.age, false);
  assert.equal(props.age.default, 30);
  assert.deepEqual(props.status.enum, ["a", "b"]);
  // format: "email" is in Anthropic's supported set -> kept
  assert.equal(props.name.format, "email");
  // array constraints: minItems kept ONLY for 0/1; maxItems/uniqueItems always stripped
  assert.equal(props.tags.minItems, 1);
  assert.equal("maxItems" in props.tags, false);
  assert.equal("uniqueItems" in props.tags, false);
  assert.equal(props.empties.minItems, 0);
});

test("toAnthropicJsonSchema: minItems 0/1 kept, larger stripped; unsupported format stripped", () => {
  const schema = Type.Object({
    one: Type.Array(Type.String(), { minItems: 1 }),
    two: Type.Array(Type.String(), { minItems: 2 }),
    slug: Type.String({ format: "custom-slug" }),
    id: Type.String({ format: "uuid" }),
  });
  const out = toAnthropicJsonSchema(schema);
  const props = out.properties as Record<string, JsonNode>;
  assert.equal(props.one.minItems, 1);
  assert.equal("minItems" in props.two, false);
  assert.equal("format" in props.slug, false);
  assert.equal(props.id.format, "uuid");
});

test("toAnthropicJsonSchema: patterns with unsupported regex features stripped, simple kept", () => {
  const schema = Type.Object({
    simple: Type.String({ pattern: "^[a-z0-9-]+$" }),
    lookahead: Type.String({ pattern: "^(?=.*[A-Z]).+$" }),
    backref: Type.String({ pattern: "^(a)\\1$" }),
    boundary: Type.String({ pattern: "\\bword\\b" }),
  });
  const out = toAnthropicJsonSchema(schema);
  const props = out.properties as Record<string, JsonNode>;
  assert.equal(props.simple.pattern, "^[a-z0-9-]+$");
  assert.equal("pattern" in props.lookahead, false);
  assert.equal("pattern" in props.backref, false);
  assert.equal("pattern" in props.boundary, false);
});

test("toAnthropicJsonSchema: oneOf rewritten to anyOf; anyOf preserved", () => {
  const schema = Type.Object({
    choice: Type.Unsafe({ oneOf: [{ type: "string" }, { type: "number" }] }),
    nullable: Type.Unsafe({ anyOf: [{ type: "string" }, { type: "null" }] }),
  });
  const out = toAnthropicJsonSchema(schema);
  const props = out.properties as Record<string, JsonNode>;
  assert.equal("oneOf" in props.choice, false);
  assert.deepEqual(props.choice.anyOf, [{ type: "string" }, { type: "number" }]);
  assert.deepEqual(props.nullable.anyOf, [{ type: "string" }, { type: "null" }]);
});

test("toAnthropicJsonSchema: does NOT mutate the hash-feeding original", () => {
  const schema = buildSchema();
  const before = JSON.stringify(schema);
  toAnthropicJsonSchema(schema);
  assert.equal(JSON.stringify(schema), before, "the exact bytes the resume hash consumes are unchanged");
  const original = view(schema);
  assert.equal(original.additionalProperties, true);
  assert.equal(original.properties?.name?.minLength, 1);
});

// ---- map keys are data, not keywords (both normalizers) ----------------------------------

test("properties literally named after keywords survive BOTH normalizers", () => {
  // A review schema might genuinely have properties named "format", "title", or "pattern";
  // keyword-stripping must not delete them from the properties map.
  const schema = Type.Object({
    format: Type.String(),
    title: Type.String(),
    pattern: Type.Optional(Type.String()),
  });

  const anthropic = toAnthropicJsonSchema(schema);
  assert.deepEqual(Object.keys(anthropic.properties as object), ["format", "title", "pattern"]);
  assert.deepEqual(anthropic.required, ["format", "title"]);

  const strict = toStrictJsonSchema(schema);
  assert.deepEqual(Object.keys(strict.properties as object), ["format", "title", "pattern"]);
  // strict still applies its all-required + nullable-optional rules to the surviving props
  assert.deepEqual(strict.required, ["format", "title", "pattern"]);
  const strictProps = strict.properties as Record<string, JsonNode>;
  assert.deepEqual(strictProps.pattern.type, ["string", "null"]);
});

test("$defs subschemas are normalized but their NAMES survive keyword filtering", () => {
  const schema = Type.Object(
    { a: Type.Ref("minLength") },
    { $defs: { minLength: Type.Object({ z: Type.String({ minLength: 3 }) }) } },
  );
  const out = toAnthropicJsonSchema(schema);
  const defs = out.$defs as Record<string, JsonNode>;
  assert.ok(defs.minLength, "a $def named after a keyword survives");
  assert.equal(defs.minLength.additionalProperties, false, "…and its subschema IS normalized");
  const z = (defs.minLength.properties as Record<string, JsonNode>).z;
  assert.equal("minLength" in z, false);
});
