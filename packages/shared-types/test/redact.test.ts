import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactText, truncateUtf8 } from "../src/index.js";

const OPAQUE = "abcdefghijklmnopqrstuvwxyz0123456789ABCD"; // 40 chars, letters + digits

describe("redactText", () => {
  it("redacts every credential form and reports redacted: true", () => {
    const cases: Array<{ input: string; forbidden: string; expected?: string }> = [
      {
        input: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
        forbidden: "MIIEow",
        expected: "[REDACTED]",
      },
      { input: "Authorization: Bearer abc.def-ghi", forbidden: "abc.def-ghi" },
      {
        input: "curl https://user:pw@host.example/path",
        forbidden: "user:pw",
        expected: "curl https://[REDACTED]@host.example/path",
      },
      {
        input: "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        forbidden: "eyJhbGci",
      },
      { input: "api_key=supersecretvalue", forbidden: "supersecretvalue", expected: "api_key=[REDACTED]" },
      { input: "token: 'quoted-secret'", forbidden: "quoted-secret", expected: "token:[REDACTED]" },
      { input: "gh token ghp_abcdefghijklmnop123456", forbidden: "ghp_", expected: "gh token [REDACTED]" },
      { input: `opaque ${OPAQUE} tail`, forbidden: OPAQUE, expected: "opaque [REDACTED] tail" },
    ];
    for (const { input, forbidden, expected } of cases) {
      const result = redactText(input);
      assert.equal(result.redacted, true, input);
      assert.ok(!result.value.includes(forbidden), `${input} -> ${result.value}`);
      assert.ok(result.value.includes("[REDACTED]"), result.value);
      if (expected !== undefined) assert.equal(result.value, expected);
    }
  });

  it("passes plain text through untouched with redacted: false", () => {
    for (const input of ["", "hello world", "the quick brown fox 123", "see the docs for details"]) {
      assert.deepEqual(redactText(input), { value: input, redacted: false });
    }
  });
});

describe("truncateUtf8", () => {
  const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
  const DEFAULT_SUFFIX = "…[truncated]";

  it("returns the input unchanged when it fits", () => {
    assert.equal(truncateUtf8("héllo", 6), "héllo");
    assert.equal(truncateUtf8("", 0), "");
  });

  it("never splits a code point and appends the default suffix", () => {
    const suffixBytes = byteLength(DEFAULT_SUFFIX);
    // U+00E9 is 2 bytes, U+1F600 is 4 bytes (a surrogate pair in UTF-16): every boundary is multi-byte.
    const input = "é\u{1F600}".repeat(7);
    const points = [...input];
    for (let maxBytes = suffixBytes + 1; maxBytes < byteLength(input); maxBytes += 1) {
      const output = truncateUtf8(input, maxBytes);
      assert.ok(output.endsWith(DEFAULT_SUFFIX), `${maxBytes}: ${output}`);
      assert.ok(byteLength(output) <= maxBytes, `${maxBytes}: ${byteLength(output)} bytes`);
      const kept = output.slice(0, -DEFAULT_SUFFIX.length);
      assert.ok(input.startsWith(kept), `${maxBytes}: kept "${kept}" is not a prefix`);
      assert.ok(!kept.includes("�"), `${maxBytes}: split a code point`);
      // Maximal: one more code point would not have fit.
      const next = points[[...kept].length];
      assert.ok(byteLength(kept + next) + suffixBytes > maxBytes, `${maxBytes}: could have kept "${next}"`);
    }
  });

  it("honors a custom suffix", () => {
    assert.equal(truncateUtf8("abcdefghij", 6, "…"), "abc…");
    assert.equal(truncateUtf8("abcdefghij", 6, ""), "abcdef");
  });

  it("degrades to a shortened suffix when the suffix alone exceeds maxBytes", () => {
    assert.equal(truncateUtf8("abcdefghij", 3), "…");
    assert.equal(truncateUtf8("abcdefghij", 5), "…[t");
    assert.equal(truncateUtf8("abcdefghij", 2), "");
    assert.equal(truncateUtf8("abcdefghij", 4, "…[x]"), "…[");
  });

  it("counts bytes exactly like Buffer.byteLength, lone surrogates included", () => {
    const samples = [
      "plain",
      "héllo wörld",
      "\u{1F600}\u{1F389}",
      "\uD83D", // lone high surrogate: 3 bytes (U+FFFD) in both encoders
      "a\uDC00b", // lone low surrogate in the middle
      "\u0000\u007F\u0080\u07FF\u0800\uFFFF", // one-, two- and three-byte boundaries
    ];
    for (const sample of samples) {
      const byteLimit = byteLength(sample);
      // At exactly its own byte length the value fits; one byte less forces truncation.
      assert.equal(truncateUtf8(sample, byteLimit, ""), sample, JSON.stringify(sample));
      const shortened = truncateUtf8(sample, byteLimit - 1, "");
      assert.notEqual(shortened, sample, JSON.stringify(sample));
      assert.ok(byteLength(shortened) <= byteLimit - 1, JSON.stringify(sample));
    }
  });
});
