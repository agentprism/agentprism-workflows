#!/usr/bin/env node
// Generate a Shields endpoint document for the aggregate downloads of the
// published AgentPrism npm packages, plus a transparent per-package breakdown.
//
// npm's bulk download endpoint does not support scoped packages, so every
// package is queried separately. All responses must describe the same period;
// nothing is written unless every response is valid.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");

const DOWNLOADS_API = process.env.AGENTPRISM_NPM_DOWNLOADS_API ?? "https://api.npmjs.org";
const PERIOD = "last-month";
const EXTERNAL_PACKAGES = Object.freeze(["@automatalabs/codex-acp"]);
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const outputDir = parseOutputDir(process.argv.slice(2));
const packageNames = await discoverPublishedPackages();
const rows = await Promise.all(packageNames.map(fetchPackageDownloads));
const { start, end } = requireMatchingPeriod(rows);
const total = rows.reduce((sum, row) => sum + row.downloads, 0);

if (!Number.isSafeInteger(total)) {
  throw new Error(`aggregate download count is not a safe integer: ${String(total)}`);
}

const endpoint = {
  schemaVersion: 1,
  label: "npm downloads",
  message: `${formatCompact(total)}/month`,
  color: "cb3837",
  namedLogo: "npm",
};

const details = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  period: {
    parameter: PERIOD,
    start,
    end,
    description: "Last 30 available days reported by npm; start and end are inclusive.",
  },
  packageCount: rows.length,
  totalDownloads: total,
  method: "Sum of separate npm point-download requests for each published package.",
  note: "Counts are per package and are not deduplicated across dependency installs.",
  packages: rows.map((row) => ({
    name: row.package,
    downloads: row.downloads,
  })),
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeJson(join(outputDir, "npm-downloads.json"), endpoint),
  writeJson(join(outputDir, "npm-downloads-details.json"), details),
]);

console.log(
  `npm-download-badge: ${formatCompact(total)}/month across ${rows.length} packages (${start}..${end})`,
);
for (const row of rows) {
  console.log(`npm-download-badge: ${row.package} ${row.downloads}`);
}

function parseOutputDir(args) {
  if (args.length !== 2 || args[0] !== "--output-dir" || args[1].length === 0) {
    throw new Error(
      "usage: node scripts/generate-npm-download-badge.mjs --output-dir <directory>",
    );
  }
  return resolve(repoRoot, args[1]);
}

async function discoverPublishedPackages() {
  const discovered = [];
  const entries = await readdir(packagesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = join(packagesDir, entry.name, "package.json");
    let source;
    try {
      source = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`cannot read ${manifestPath}: ${errorMessage(error)}`);
    }

    let manifest;
    try {
      manifest = JSON.parse(source);
    } catch (error) {
      throw new Error(`cannot parse ${manifestPath}: ${errorMessage(error)}`);
    }

    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@automatalabs/")) {
      continue;
    }
    if (manifest.private === true) continue;
    if (manifest.publishConfig?.access !== "public") {
      throw new Error(
        `${manifestPath}: non-private @automatalabs package must set publishConfig.access to public`,
      );
    }
    discovered.push(manifest.name);
  }

  const names = [...new Set([...discovered, ...EXTERNAL_PACKAGES])].sort();
  if (names.length === 0) throw new Error("no published @automatalabs packages were discovered");
  return names;
}

async function fetchPackageDownloads(packageName) {
  const url = new URL(
    `/downloads/point/${PERIOD}/${encodeURIComponent(packageName)}`,
    ensureTrailingSlash(DOWNLOADS_API),
  );
  const response = await fetchWithRetry(url);

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`invalid JSON for ${packageName}: ${errorMessage(error)}`);
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`invalid response for ${packageName}: expected an object`);
  }
  if (payload.package !== packageName) {
    throw new Error(
      `invalid response for ${packageName}: package was ${JSON.stringify(payload.package)}`,
    );
  }
  if (!Number.isSafeInteger(payload.downloads) || payload.downloads < 0) {
    throw new Error(
      `invalid response for ${packageName}: downloads was ${JSON.stringify(payload.downloads)}`,
    );
  }
  if (!validIsoDate(payload.start) || !validIsoDate(payload.end) || payload.start > payload.end) {
    throw new Error(
      `invalid response period for ${packageName}: ${JSON.stringify(payload.start)}..${JSON.stringify(payload.end)}`,
    );
  }

  return {
    package: packageName,
    downloads: payload.downloads,
    start: payload.start,
    end: payload.end,
  };
}

async function fetchWithRetry(url) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.ok) return response;

      const error = new Error(`HTTP ${response.status} from ${url}`);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      if (/^HTTP 4\d\d /.test(errorMessage(error)) && !/^HTTP 429 /.test(errorMessage(error))) {
        throw error;
      }
      lastError = error;
    }

    if (attempt < FETCH_ATTEMPTS) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, RETRY_DELAY_MS * attempt),
      );
    }
  }

  throw new Error(
    `request failed after ${FETCH_ATTEMPTS} attempts (${errorMessage(lastError)})`,
  );
}

function requireMatchingPeriod(results) {
  const first = results[0];
  if (!first) throw new Error("npm returned no package results");

  for (const row of results.slice(1)) {
    if (row.start !== first.start || row.end !== first.end) {
      throw new Error(
        `npm returned mismatched periods: ${first.package}=${first.start}..${first.end}, ` +
          `${row.package}=${row.start}..${row.end}`,
      );
    }
  }
  return { start: first.start, end: first.end };
}

function validIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function formatCompact(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  })
    .format(value)
    .toLowerCase();
}

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
