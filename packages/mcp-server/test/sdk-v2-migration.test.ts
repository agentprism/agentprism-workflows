import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:[cm]?[jt]sx?|d\.ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("production MCP server graph uses split SDK v2 and keeps ext-apps browser-only", () => {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(manifest.dependencies["@modelcontextprotocol/sdk"], undefined);
  assert.equal(manifest.dependencies["@modelcontextprotocol/ext-apps"], undefined);
  assert.equal(manifest.dependencies["@modelcontextprotocol/client"], "^2.0.0");
  assert.equal(manifest.dependencies["@modelcontextprotocol/server"], "^2.0.0");
  assert.equal(manifest.dependencies["@modelcontextprotocol/node"], "^2.0.0");
  assert.equal(manifest.devDependencies["@modelcontextprotocol/ext-apps"], "^1.7.5");
  assert.equal(manifest.devDependencies["@modelcontextprotocol/sdk"], "1.30.0");

  for (const file of [...sourceFiles(join(packageDir, "src")), ...sourceFiles(join(packageDir, "scripts"))]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /@modelcontextprotocol\/sdk(?:\/|["'])/, file);
    assert.doesNotMatch(source, /@modelcontextprotocol\/ext-apps\/server/, file);
  }
});
