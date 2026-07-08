// openWorkflowDir: the read-only, per-call-fresh view over folders of workflow scripts.
// Everything here is plain filesystem behavior — no engine run, no agents.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openWorkflowDir } from "../src/workflow-dir.js";

const ROOT = mkdtempSync(join(tmpdir(), "workflow-dir-test-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function makeDir(name: string, files: Record<string, string>): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

const script = (name: string, body = "return 1;") =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "d" };\n${body}`;

describe("openWorkflowDir", () => {
  it("construction does no I/O and tolerates directories that do not exist", () => {
    const flows = openWorkflowDir(join(ROOT, "does-not-exist"));
    assert.deepEqual(flows.list(), []);
    assert.equal(flows.resolve("anything"), undefined);
  });

  it("resolves relative dirs against options.cwd and exposes absolute dirs", () => {
    makeDir("rel", { "a.js": script("a") });
    const flows = openWorkflowDir("rel", { cwd: ROOT });
    assert.deepEqual(flows.dirs, [join(ROOT, "rel")]);
    assert.equal(flows.resolve("a"), script("a"));
  });

  it("list() scans per call (fresh), parses meta, sorts by name, and reports parse errors", () => {
    const dir = makeDir("list", { "beta.workflow.js": script("beta"), "alpha.js": script("alpha") });
    const flows = openWorkflowDir(dir);
    assert.deepEqual(
      flows.list().map((e) => ({ name: e.name, meta: e.meta?.name })),
      [
        { name: "alpha", meta: "alpha" },
        { name: "beta", meta: "beta" },
      ],
    );
    // A file added AFTER construction is visible — nothing was cached.
    writeFileSync(join(dir, "gamma.js"), "const x = 1; // no meta");
    const gamma = flows.list().find((e) => e.name === "gamma");
    assert.equal(gamma?.meta, undefined);
    assert.match(gamma?.error ?? "", /export const meta/);
  });

  it("first dir wins across dirs; .workflow.js beats .js within a dir", () => {
    const primary = makeDir("prec-a", { "dup.js": script("primary"), "spec.workflow.js": script("specific"), "spec.js": script("generic") });
    const secondary = makeDir("prec-b", { "dup.js": script("secondary"), "only-b.js": script("only-b") });
    const flows = openWorkflowDir([primary, secondary]);
    assert.equal(flows.resolve("dup"), script("primary"));
    assert.equal(flows.resolve("spec"), script("specific"));
    assert.equal(flows.resolve("only-b"), script("only-b"));
    assert.deepEqual(
      flows.list().map((e) => e.meta?.name).sort(),
      ["only-b", "primary", "specific"],
    );
  });

  it("resolve() rejects non-names: inline scripts, path separators, traversal, dotfiles", () => {
    const dir = makeDir("guard", { "real.js": script("real") });
    // Plant a file OUTSIDE the dir that a traversal would reach.
    writeFileSync(join(ROOT, "secret.js"), script("secret"));
    const flows = openWorkflowDir(dir);
    assert.equal(flows.resolve(script("inline")), undefined); // a full inline script string
    assert.equal(flows.resolve("../secret"), undefined);
    assert.equal(flows.resolve("sub/real"), undefined);
    assert.equal(flows.resolve(".hidden"), undefined);
    assert.equal(flows.resolve("real"), script("real"));
  });

  it("read() returns the script or throws with searched dirs and closest matches", () => {
    const dir = makeDir("read", { "review-pr.workflow.js": script("review-pr"), "release.js": script("release") });
    const flows = openWorkflowDir(dir);
    assert.equal(flows.read("review-pr"), script("review-pr"));
    assert.throws(
      () => flows.read("reviw-pr"),
      (error: Error) => {
        assert.match(error.message, /workflow "reviw-pr" not found/);
        assert.ok(error.message.includes(dir));
        assert.match(error.message, /Did you mean: review-pr/);
        return true;
      },
    );
  });

  it("resolve() IS a loadSavedWorkflow resolver: unbound, (name) => string | undefined", () => {
    const dir = makeDir("hook", { "child.js": script("child") });
    const { resolve } = openWorkflowDir(dir); // detached on purpose — must not rely on `this`
    assert.equal(resolve("child"), script("child"));
    assert.equal(resolve("nope"), undefined);
  });
});
