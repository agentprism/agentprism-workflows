#!/usr/bin/env node
// Keep stdout reserved for ACP before importing modules that may log during evaluation.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  const manifest = await import("../package.json", { with: { type: "json" } }).then(
    (module) => module.default,
  );
  process.stdout.write(`${manifest.version}\n`);
  process.exit(0);
}

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

const abortController = new AbortController();
process.once("SIGTERM", () => abortController.abort(new Error("SIGTERM")));
process.once("SIGINT", () => abortController.abort(new Error("SIGINT")));

try {
  const { serveAcpServer } = await import("./server.js");
  await serveAcpServer({ signal: abortController.signal });
} catch (error) {
  if (!abortController.signal.aborted) {
    console.error("ACP server failed:", error);
    process.exitCode = 1;
  }
}
