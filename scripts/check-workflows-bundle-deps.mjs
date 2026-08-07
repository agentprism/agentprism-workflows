#!/usr/bin/env node
// Bundled-runtime-dependency gate for @automatalabs/workflows (fresh-install safety).
//
// WHY THIS EXISTS. packages/workflows ships its MCP entry by BUNDLING the mcp-server source:
//   esbuild ../mcp-server/src/entry.ts --bundle --external:@automatalabs/* --outfile=dist/mcp-server.js
// Everything is inlined EXCEPT `@automatalabs/*`, which stays a bare runtime import in the emitted
// dist/mcp-server.js and is resolved from the PUBLISHED @automatalabs/workflows package at run time.
// So every `@automatalabs/*` specifier left in the bundle must be resolvable from a FRESH install of
// @automatalabs/workflows — either it is the package's OWN name (a Node self-reference, which needs
// the used subpath to be in the package `exports` map) or it is declared in this package's
// dependencies (so the package manager installs it alongside). Workspace symlinks make every such
// import resolve locally, which is why CI, the unit tests and the pre-push e2e all stayed green while
// the published 0.46.4 threw `ERR_MODULE_NOT_FOUND` for '@automatalabs/repl-engine' on the very first
// `npx -y @automatalabs/workflows mcp` of a fresh machine: the REPL-orchestrator work added
// repl-engine imports to the bundled source, but packages/workflows/package.json never declared the
// dependency. Only a fresh registry install exposes that gap; this gate reproduces it offline.
//
// WHAT IT CHECKS. Parse the BUILT dist/mcp-server.js, collect every EXTERNAL bare `@automatalabs/*`
// specifier that actually sits in module-specifier position (import/export-from, side-effect import,
// dynamic import(), and require() — including esbuild's emitted `__require()` shim form), and require
// each to be EITHER:
//   (a) this package's own name — a Node self-reference; verify the `exports` map really resolves the
//       used subpath (bare `@automatalabs/workflows` -> "." ), and FAIL if it does not; or
//   (b) declared in packages/workflows/package.json `dependencies` (ONLY dependencies — see below).
// A specifier that is neither fails the gate with the exact `pnpm --filter` fix. The scope is exactly
// `@automatalabs/*` on purpose: it is the sole `--external` esbuild is given, so it is the only family
// of bare imports the bundle can leave unresolved for a consumer (node: builtins are always present).
//
// PARSING, ROBUSTLY, ZERO-DEP. The bundle embeds a large prose string (the authoring prompt) that
// MENTIONS other `@automatalabs/*` package names, and — like any real esbuild output — contains
// string and regex literals. A naive grep would raise false positives off the prose. So this scanner
// blanks comments and string/template/regex literals before matching, replacing each `'…'`/`"…"`
// literal with a sentinel placeholder that records its decoded value; module specifiers are then read
// off the placeholder stream by their surrounding keyword, so a package name mentioned in prose (it
// lives INSIDE a blanked string) can never be read as an import. Since `'…'`/`"…"` strings and `/…/`
// regexes never cross a raw newline in JS, each is bounded to its own physical line, so no mis-lex can
// reach across lines to hide a real import on another line. Node built-ins only.
//
// HOW IT IS ENFORCED. Wired into the packages/workflows `build` script (right after esbuild emits the
// bundle), the same idiom mcp-server's `build:ui` uses to call a repo script. `pnpm build` runs it in
// CI's "Build & test" required job, in the pre-push hook, and in release.yml — every path that emits
// the bundle validates it. Run standalone against an already-built tree with:
//   node scripts/check-workflows-bundle-deps.mjs
// The gate FAILS CLOSED: a missing bundle or unreadable manifest is a blocker, not a pass.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(repoRoot, "packages", "workflows");
const manifestPath = join(pkgDir, "package.json");
const bundlePath = join(pkgDir, "dist", "mcp-server.js");

function fail(message) {
  console.error(`workflows-bundle-deps: ${message}`);
  process.exit(1);
}

// ---- load the manifest --------------------------------------------------------------------------
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`cannot read or parse ${manifestPath} (${error instanceof Error ? error.message : String(error)})`);
}
const ownName = manifest.name;
if (typeof ownName !== "string" || ownName.length === 0) {
  fail(`${manifestPath} has no package name`);
}
// ONLY `dependencies` guarantees the package is on disk after a fresh install. `optionalDependencies`
// may be skipped by the consumer or fail to install (e.g. an unmet OS/CPU constraint) and still count
// the install a success, leaving the same runtime `ERR_MODULE_NOT_FOUND`; `peerDependencies` are the
// consumer's responsibility to provide. Neither reliably resolves a bundled runtime import, so only
// `dependencies` satisfies this gate.
const declared = new Set(Object.keys(manifest.dependencies ?? {}));

// ---- load the built bundle (fail closed if it is not there) -------------------------------------
if (!existsSync(bundlePath)) {
  fail(
    `built bundle not found at ${bundlePath} — run \`pnpm --filter ${ownName} build\` first (the gate cannot verify what was not built)`,
  );
}
const bundle = readFileSync(bundlePath, "utf8");

// ---- blank comments + string/template/regex literals, keep only module-specifier strings --------
// Private-use sentinels delimit a placeholder (OPEN<index>CLOSE); they cannot occur in JS source.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const REGEX_ALLOWED_BEFORE = new Set("([{,;:=!&|?+-*%~^<>".split(""));
const REGEX_ALLOWED_KEYWORD = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|do|else|yield|await|case)$/;

function scrub(code) {
  const literals = [];
  let out = "";
  let tail = ""; // recent emitted chars, for the regex-vs-division decision
  const pushCode = (s) => {
    out += s;
    tail = (tail + s).slice(-40);
  };
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];

    if (c === "/" && c2 === "/") {
      i += 2;
      while (i < n && code[i] !== "\n") i++;
      continue; // leave the newline for the next iteration
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      pushCode(" ");
      continue;
    }
    if (c === "'" || c === '"') {
      // String literal, bounded to this physical line (JS string literals do not cross a raw
      // newline; the embedded prompt is one line of `\n`-escape sequences, so this holds for it too).
      const quote = c;
      let j = i + 1;
      let val = "";
      let closed = false;
      while (j < n) {
        const d = code[j];
        if (d === "\n") break; // unterminated on this line -> stop, do not swallow across lines
        if (d === "\\") {
          val += code[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (d === quote) {
          closed = true;
          j++;
          break;
        }
        val += d;
        j++;
      }
      if (closed) {
        const idx = literals.length;
        literals.push(val);
        out += `${OPEN}${idx}${CLOSE}`;
        tail = "";
        i = j;
        continue;
      }
      // Not a closed string on this line — emit the quote as an ordinary char and move on.
      pushCode(c);
      i++;
      continue;
    }
    if (c === "`") {
      // Template literal: may span lines and nest `${ … }` expressions (which are code). Blank the
      // template text; keep interpolation code so an import() inside one is still seen.
      i++;
      while (i < n) {
        const d = code[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "`") {
          i++;
          break;
        }
        if (d === "$" && code[i + 1] === "{") {
          i += 2;
          let depth = 1;
          let inner = "";
          while (i < n && depth > 0) {
            const e = code[i];
            if (e === "{") depth++;
            else if (e === "}") {
              depth--;
              if (depth === 0) {
                i++;
                break;
              }
            }
            inner += e;
            i++;
          }
          const scrubbed = scrub(inner);
          const base = literals.length;
          for (const lit of scrubbed.literals) literals.push(lit);
          // Re-base the inner placeholders onto this literals array.
          const rebase = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");
          out += ` ${scrubbed.out.replace(rebase, (_m, d2) => `${OPEN}${base + Number(d2)}${CLOSE}`)} `;
          tail = "";
          continue;
        }
        i++;
      }
      pushCode(" ");
      continue;
    }
    if (c === "/") {
      // `/` that is not a comment: regex literal or division. Use the standard preceding-token
      // heuristic; a regex literal is bounded to this line, so a wrong guess cannot swallow across
      // lines. On a newline before the closing `/`, treat the `/` as division after all.
      const t = tail.replace(/\s+$/, "");
      const last = t[t.length - 1];
      const regexAllowed = t === "" || REGEX_ALLOWED_BEFORE.has(last) || REGEX_ALLOWED_KEYWORD.test(t);
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n) {
          const d = code[j];
          if (d === "\n") break;
          if (d === "\\") {
            j += 2;
            continue;
          }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) {
            ok = true;
            j++;
            break;
          }
          j++;
        }
        if (ok) {
          while (j < n && /[a-z]/i.test(code[j])) j++; // skip regex flags
          pushCode(" ");
          i = j;
          continue;
        }
      }
      pushCode(c); // division
      i++;
      continue;
    }
    pushCode(c);
    i++;
  }
  return { out, literals };
}

const { out: scrubbed, literals } = scrub(bundle);

// ---- pull specifiers from the placeholder stream ------------------------------------------------
// Every form whose string argument is a module specifier: `… from "x"` (import/export-from), the
// side-effect `import "x"`, the dynamic `import("x")`, and a require call `…require("x")`.
// Placeholders are OPEN<index>CLOSE, so anchor on OPEN.
//
// The require form must match esbuild's OWN emission, not just hand-written `require(`: with
// `--format=esm`, esbuild rewrites every CommonJS `require("x")` in the bundled source into a call
// to its generated shim `__require("x")` (verified with an esbuild probe). A `\brequire\b` anchor
// would MISS `__require(` — the `_` before `require` is a word char, so there is no word boundary
// there — silently letting an undeclared `__require("@automatalabs/…")` through. So the callee is
// matched as an optional identifier prefix, then `require`, then esbuild's collision suffix digits:
// `(?:^|[^\w$])[\w$]*require\d*\s*\(` catches bare `require(`, esbuild's `__require(`, and a renamed
// `__require2(` alike. This only ever OVER-approximates (a callee whose name ends in `require`+digits),
// which fails safe — it can add a specifier to check, never drop one.
const O = OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = [
  new RegExp(`\\bfrom\\s*${O}(\\d+)`, "g"),
  new RegExp(`\\bimport\\s+${O}(\\d+)`, "g"),
  new RegExp(`\\bimport\\s*\\(\\s*${O}(\\d+)`, "g"),
  new RegExp(`(?:^|[^\\w$])[\\w$]*require\\d*\\s*\\(\\s*${O}(\\d+)`, "g"),
];
const specIndexes = new Set();
for (const re of patterns) {
  for (const m of scrubbed.matchAll(re)) specIndexes.add(Number(m[1]));
}

const specifiers = new Set();
for (const idx of specIndexes) {
  const value = literals[idx];
  if (typeof value === "string" && value.startsWith("@automatalabs/")) specifiers.add(value);
}

// ---- classify each external @automatalabs/* specifier -------------------------------------------
// A bare `@scope/name` specifier is the package name; anything after the second segment is a subpath.
function splitSpecifier(spec) {
  const parts = spec.split("/");
  const name = `${parts[0]}/${parts[1]}`;
  const subpath = parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".";
  return { name, subpath };
}

// Does the package `exports` map resolve `subpath` (for the self-reference case)?
function subpathIsExported(exports, subpath) {
  if (exports === undefined || exports === null) return false;
  if (typeof exports === "string") return subpath === ".";
  if (typeof exports !== "object" || Array.isArray(exports)) return false;
  const keys = Object.keys(exports);
  const hasSubpathKeys = keys.some((k) => k === "." || k.startsWith("./"));
  if (!hasSubpathKeys) {
    // Conditions-only sugar (e.g. { import, require, default }) — resolves the root only.
    return subpath === ".";
  }
  if (Object.prototype.hasOwnProperty.call(exports, subpath) && exports[subpath] !== null) return true;
  // Pattern subpaths, e.g. "./*" or "./feat/*".
  for (const key of keys) {
    if (!key.includes("*") || exports[key] === null) continue;
    const [pre, post] = key.split("*");
    if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= pre.length + post.length) {
      return true;
    }
  }
  return false;
}

const violations = [];
for (const spec of [...specifiers].sort()) {
  const { name, subpath } = splitSpecifier(spec);
  if (name === ownName) {
    if (!subpathIsExported(manifest.exports, subpath)) {
      violations.push(
        `self-reference '${spec}' is not resolvable: ${ownName} \`exports\` does not map subpath "${subpath}" ` +
          `— add it to packages/workflows/package.json "exports" (and its publishConfig.exports)`,
      );
    } else {
      console.error(`workflows-bundle-deps: '${spec}' -> self-reference, exports maps "${subpath}" — ok`);
    }
    continue;
  }
  if (declared.has(name)) {
    console.error(`workflows-bundle-deps: '${spec}' -> declared dependency ${name} — ok`);
    continue;
  }
  violations.push(
    `bundled runtime import '${spec}' is NOT declared in packages/workflows/package.json — a fresh ` +
      `install of ${ownName} would throw ERR_MODULE_NOT_FOUND. Fix: pnpm --filter ${ownName} add ${name}@workspace:* ` +
      `(then commit the pnpm-lock.yaml change and add a changeset)`,
  );
}

if (violations.length > 0) {
  console.error("");
  console.error(
    `workflows-bundle-deps: ${bundlePath} imports @automatalabs/* specifier(s) a fresh install cannot resolve:`,
  );
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.error(
  `workflows-bundle-deps: all ${specifiers.size} external @automatalabs/* import(s) in the bundle are resolvable — ok`,
);
process.exit(0);
