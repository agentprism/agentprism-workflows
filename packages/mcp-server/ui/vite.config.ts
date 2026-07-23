import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The run-monitor panel must be a single self-contained HTML document: MCP Apps hosts render
// it inside a sandboxed iframe with a strict CSP, so every script/style is inlined.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "run-monitor.html",
    },
  },
});
