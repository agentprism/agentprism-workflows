---
"@automatalabs/workflows": patch
---

Fix a fresh-install crash: declare the `@automatalabs/repl-engine` runtime dependency.

`@automatalabs/workflows` ships its MCP entry by bundling the mcp-server source with esbuild under
`--external:@automatalabs/*`, so every `@automatalabs/*` import in that source stays a bare runtime
import in `dist/mcp-server.js` and is resolved from the installed `@automatalabs/workflows` package.
The REPL-orchestrator work added `@automatalabs/repl-engine` imports to the bundled source, but this
package's manifest never declared the dependency (mcp-server's did). Workspace symlinks resolved it
locally, so CI, the unit tests and the pre-push e2e stayed green — but a fresh registry install had no
`@automatalabs/repl-engine` on disk, and `npx -y @automatalabs/workflows mcp` threw
`ERR_MODULE_NOT_FOUND` for '@automatalabs/repl-engine' imported from `dist/mcp-server.js` on the first
run of every clean machine. The fix declares `@automatalabs/repl-engine` in `dependencies` so the
package manager installs it alongside `@automatalabs/workflows`.

A new build-time gate (`scripts/check-workflows-bundle-deps.mjs`, run at the end of the package
`build` and therefore in CI, the pre-push hook, and release) parses the built `dist/mcp-server.js` and
requires every external bare `@automatalabs/*` specifier in it — in `import`/`export … from`,
side-effect `import`, dynamic `import()`, and `require()`/esbuild's `__require()` positions — to be
either this package's own name (a Node self-reference whose used subpath is covered by the `exports`
map) or declared in this package's `dependencies` (only `dependencies`, since `optionalDependencies`
and `peerDependencies` are not guaranteed installed), so this specific class of undeclared-bundled-import
regression cannot ship again.
