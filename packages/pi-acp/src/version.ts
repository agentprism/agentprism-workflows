import { readFileSync } from "node:fs";

export const PKG_VERSION = String(
  (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: unknown }).version,
);
