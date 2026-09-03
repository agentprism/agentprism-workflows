#!/usr/bin/env node
// Generate a Shields endpoint document for the aggregate downloads of the
// published AgentPrism npm packages, plus a transparent per-package breakdown.
//
// npm's bulk download endpoint does not support scoped packages, so every
// package is queried separately. All responses must describe the same period.
// A range 404 is accepted only when registry metadata proves the package was
// created after the requested window, in which case its exact contribution is
// zero; nothing is written unless every other response is valid.
//
// npm's named `last-month` alias can lag behind its explicit-date data even
// when cache-busting and no-cache headers are used. Build an exact 30-day UTC
// range instead, ending two full days ago so npm's daily aggregation has time
// to settle. Range responses must contain every requested day in order, and
// the aggregate final day must be non-zero. A failed completeness check writes
// nothing, preserving the previously published badge rather than presenting
// incomplete counts as fresh.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");

const DOWNLOADS_API = process.env.AGENTPRISM_NPM_DOWNLOADS_API ?? "https://api.npmjs.org";
const NPM_REGISTRY = process.env.AGENTPRISM_NPM_REGISTRY ?? "https://registry.npmjs.org";
const WINDOW_DAYS = 30;
const REPORTING_LAG_DAYS = 2;
const EXTERNAL_PACKAGES = Object.freeze(["@automatalabs/codex-acp"]);
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1_000;

const generatedAt = reportingNow();
const period = reportingPeriod(generatedAt);
const outputDir = parseOutputDir(process.argv.slice(2));
const packageNames = await discoverPublishedPackages();
const rows = await Promise.all(
  packageNames.map((packageName) => fetchPackageDownloads(packageName, period)),
);
const { start, end } = requireMatchingPeriod(rows, period);
requireCompleteFinalDay(rows, end);
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
  generatedAt: generatedAt.toISOString(),
  period: {
    parameter: period.parameter,
    start,
    end,
    reportingLagDays: REPORTING_LAG_DAYS,
    description: "Explicit 30-day UTC window ending two full days before generation; start and end are inclusive.",
  },
  packageCount: rows.length,
  totalDownloads: total,
  method: "Sum of validated daily rows from separate npm range requests; registry-confirmed packages created after the window contribute zero.",
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

async function fetchPackageDownloads(packageName, period) {
  const url = new URL(
    `/downloads/range/${period.parameter}/${encodeURIComponent(packageName)}`,
    ensureTrailingSlash(DOWNLOADS_API),
  );
  // Explicit periods change daily, but retain cache busting for repeated same-day runs and
  // intermediaries that ignore request cache directives.
  url.searchParams.set("t", `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  let response;
  try {
    response = await fetchWithRetry(url);
  } catch (error) {
    if (error?.status === 404) {
      return zeroDownloadsForPackageCreatedAfterPeriod(packageName, period);
    }
    throw error;
  }

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
  if (payload.start !== period.start || payload.end !== period.end) {
    throw new Error(
      `npm returned the wrong explicit period for ${packageName}: ` +
        `${JSON.stringify(payload.start)}..${JSON.stringify(payload.end)} ` +
        `(expected ${period.start}..${period.end})`,
    );
  }
  if (!Array.isArray(payload.downloads)) {
    throw new Error(`invalid response for ${packageName}: downloads was not an array`);
  }
  if (payload.downloads.length !== period.days.length) {
    throw new Error(
      `incomplete response for ${packageName}: received ${payload.downloads.length} daily rows ` +
        `(expected ${period.days.length})`,
    );
  }

  let downloads = 0;
  const daily = payload.downloads.map((entry, index) => {
    const expectedDay = period.days[index];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`invalid daily response for ${packageName} on ${expectedDay}: expected an object`);
    }
    if (entry.day !== expectedDay) {
      throw new Error(
        `incomplete response for ${packageName}: daily row ${index} was ${JSON.stringify(entry.day)} ` +
          `(expected ${expectedDay})`,
      );
    }
    if (!Number.isSafeInteger(entry.downloads) || entry.downloads < 0) {
      throw new Error(
        `invalid daily downloads for ${packageName} on ${expectedDay}: ${JSON.stringify(entry.downloads)}`,
      );
    }
    downloads += entry.downloads;
    if (!Number.isSafeInteger(downloads)) {
      throw new Error(`download total for ${packageName} is not a safe integer`);
    }
    return { day: entry.day, downloads: entry.downloads };
  });

  return {
    package: packageName,
    downloads,
    daily,
    start: payload.start,
    end: payload.end,
  };
}

async function zeroDownloadsForPackageCreatedAfterPeriod(packageName, period) {
  const url = new URL(encodeURIComponent(packageName), ensureTrailingSlash(NPM_REGISTRY));
  url.searchParams.set("t", `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  const response = await fetchWithRetry(url);

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`invalid registry JSON for ${packageName}: ${errorMessage(error)}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`invalid registry response for ${packageName}: expected an object`);
  }
  if (payload.name !== packageName) {
    throw new Error(
      `invalid registry response for ${packageName}: name was ${JSON.stringify(payload.name)}`,
    );
  }

  const created = payload.time?.created;
  const createdAt = typeof created === "string" ? Date.parse(created) : Number.NaN;
  if (!Number.isFinite(createdAt)) {
    throw new Error(
      `invalid registry response for ${packageName}: time.created was ${JSON.stringify(created)}`,
    );
  }
  const firstDayAfterPeriod = Date.parse(`${shiftIsoDate(period.end, 1)}T00:00:00.000Z`);
  if (createdAt < firstDayAfterPeriod) {
    throw new Error(
      `npm downloads API returned 404 for ${packageName}, but registry metadata says it was ` +
        `created during or before the requested period (${created})`,
    );
  }

  return {
    package: packageName,
    downloads: 0,
    daily: period.days.map((day) => ({ day, downloads: 0 })),
    start: period.start,
    end: period.end,
  };
}

async function fetchWithRetry(url) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) return response;

      const error = new Error(`HTTP ${response.status} from ${url}`);
      error.status = response.status;
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

function reportingNow() {
  const override = process.env.AGENTPRISM_NPM_DOWNLOADS_NOW;
  const now = override === undefined ? new Date() : new Date(override);
  if (!Number.isFinite(now.getTime())) {
    throw new Error(`AGENTPRISM_NPM_DOWNLOADS_NOW must be an ISO timestamp, got ${JSON.stringify(override)}`);
  }
  return now;
}

function reportingPeriod(now) {
  const today = now.toISOString().slice(0, 10);
  const end = shiftIsoDate(today, -REPORTING_LAG_DAYS);
  const start = shiftIsoDate(end, -(WINDOW_DAYS - 1));
  const days = Array.from({ length: WINDOW_DAYS }, (_, index) => shiftIsoDate(start, index));
  return { parameter: `${start}:${end}`, start, end, days };
}

function shiftIsoDate(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function requireMatchingPeriod(results, expected) {
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
  if (first.start !== expected.start || first.end !== expected.end) {
    throw new Error(
      `npm returned ${first.start}..${first.end}, expected explicit period ${expected.start}..${expected.end}`,
    );
  }
  return { start: first.start, end: first.end };
}

/** Explicit date endpoints represent not-yet-ingested days as zero rather than reporting that
 *  the day is unavailable. Across the complete published package set a zero aggregate is a
 *  reliable fail-closed signal that the requested final day has not settled yet. */
function requireCompleteFinalDay(results, endDate) {
  let downloads = 0;
  for (const row of results) {
    const finalDay = row.daily.at(-1);
    if (finalDay?.day !== endDate) {
      throw new Error(`incomplete response for ${row.package}: missing final day ${endDate}`);
    }
    downloads += finalDay.downloads;
    if (!Number.isSafeInteger(downloads)) {
      throw new Error(`aggregate downloads for final day ${endDate} is not a safe integer`);
    }
  }
  if (downloads === 0) {
    throw new Error(
      `npm reported zero downloads across all ${results.length} packages for ${endDate}; ` +
        "the explicit reporting window has not settled — refusing to publish incomplete counts",
    );
  }
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
