import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "generate-npm-download-badge.mjs");
const now = "2026-09-03T04:27:05.000Z";
const expectedStart = "2026-08-03";
const expectedEnd = "2026-09-01";
const expectedPeriod = `${expectedStart}:${expectedEnd}`;
const expectedDays = isoDays(expectedStart, 30);

// The production regression: npm's named last-month alias can remain pinned to an older
// end date even while explicit-date package data advances. The generator must never request
// an alias, and must validate the exact daily rows behind its aggregate.
test("download badge uses a complete explicit 30-day UTC window", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-npm-downloads-"));
  const api = await startDownloadsApi(({ packageName }) => responseFor(packageName));

  try {
    const result = await runGenerator(outputDir, api.url);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(api.requests.length > 0);
    assert.ok(api.requests.every((request) => request.period === expectedPeriod));
    assert.ok(api.requests.every((request) => request.cacheBust.length > 0));
    assert.ok(api.requests.every((request) => request.cacheControl === "no-cache"));
    assert.ok(api.requests.every((request) => request.pragma === "no-cache"));
    assert.equal(new Set(api.requests.map((request) => request.packageName)).size, api.requests.length);

    const badge = JSON.parse(await readFile(join(outputDir, "npm-downloads.json"), "utf8"));
    const details = JSON.parse(await readFile(join(outputDir, "npm-downloads-details.json"), "utf8"));
    const perPackage = expectedDays.reduce((sum, _day, index) => sum + index + 1, 0);

    assert.equal(details.generatedAt, now);
    assert.deepEqual(details.period, {
      parameter: expectedPeriod,
      start: expectedStart,
      end: expectedEnd,
      reportingLagDays: 2,
      description: "Explicit 30-day UTC window ending two full days before generation; start and end are inclusive.",
    });
    assert.equal(details.packageCount, api.requests.length);
    assert.equal(details.method, "Sum of validated daily rows from separate npm range requests; registry-confirmed packages created after the window contribute zero.");
    assert.equal(details.totalDownloads, perPackage * details.packageCount);
    assert.equal(badge.message, `${formatCompact(details.totalDownloads)}/month`);
    assert.match(result.stdout, new RegExp(`\\(${expectedStart}\\.\\.${expectedEnd}\\)`));
  } finally {
    await api.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("download badge counts a registry-confirmed post-window package as zero when npm has no range yet", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-npm-downloads-new-package-"));
  const newPackage = "@automatalabs/acp-server";
  const api = await startDownloadsApi(
    ({ packageName }) => packageName === newPackage
      ? { httpStatus: 404, body: { error: "package has no download data" } }
      : responseFor(packageName),
    ({ packageName }) => packageName === newPackage
      ? { name: newPackage, time: { created: "2026-09-03T19:13:00.000Z" } }
      : null,
  );

  try {
    const result = await runGenerator(outputDir, api.url);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(api.registryRequests, [newPackage]);

    const details = JSON.parse(await readFile(join(outputDir, "npm-downloads-details.json"), "utf8"));
    const row = details.packages.find((entry) => entry.name === newPackage);
    assert.deepEqual(row, { name: newPackage, downloads: 0 });
    assert.match(result.stdout, /@automatalabs\/acp-server 0/);
  } finally {
    await api.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("download badge rejects a range 404 for a package that existed within the window", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-npm-downloads-missing-existing-"));
  const missingPackage = "@automatalabs/acp-server";
  const api = await startDownloadsApi(
    ({ packageName }) => packageName === missingPackage
      ? { httpStatus: 404, body: { error: "missing" } }
      : responseFor(packageName),
    ({ packageName }) => packageName === missingPackage
      ? { name: missingPackage, time: { created: "2026-08-20T12:00:00.000Z" } }
      : null,
  );

  try {
    const result = await runGenerator(outputDir, api.url);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /downloads API returned 404.*created during or before the requested period/s);
    await assertNotPublished(outputDir);
  } finally {
    await api.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("download badge rejects a stale substituted period without publishing", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-npm-downloads-stale-"));
  const api = await startDownloadsApi(({ packageName }) => ({
    ...responseFor(packageName),
    start: "2026-07-31",
    end: "2026-08-29",
  }));

  try {
    const result = await runGenerator(outputDir, api.url);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /wrong explicit period.*expected 2026-08-03\.\.2026-09-01/s);
    await assertNotPublished(outputDir);
  } finally {
    await api.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("download badge rejects a structurally incomplete explicit range without publishing", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-npm-downloads-incomplete-"));
  const api = await startDownloadsApi(({ packageName }) => ({
    ...responseFor(packageName),
    downloads: responseFor(packageName).downloads.slice(0, -1),
  }));

  try {
    const result = await runGenerator(outputDir, api.url);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /incomplete response.*received 29 daily rows.*expected 30/s);
    await assertNotPublished(outputDir);
  } finally {
    await api.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("download badge rejects an explicit final day that has not settled", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentprism-npm-downloads-unsettled-"));
  const api = await startDownloadsApi(({ packageName }) => ({
    ...responseFor(packageName),
    downloads: expectedDays.map((day, index) => ({
      day,
      downloads: index === expectedDays.length - 1 ? 0 : index + 1,
    })),
  }));

  try {
    const result = await runGenerator(outputDir, api.url);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /zero downloads across all \d+ packages.*has not settled/s);
    await assertNotPublished(outputDir);
  } finally {
    await api.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

function responseFor(packageName) {
  return {
    package: packageName,
    start: expectedStart,
    end: expectedEnd,
    downloads: expectedDays.map((day, index) => ({ day, downloads: index + 1 })),
  };
}

function formatCompact(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value).toLowerCase();
}

function isoDays(start, count) {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(startMs + index * 86_400_000).toISOString().slice(0, 10)
  );
}

async function assertNotPublished(outputDir) {
  for (const name of ["npm-downloads.json", "npm-downloads-details.json"]) {
    await assert.rejects(
      stat(join(outputDir, name)),
      (error) => error?.code === "ENOENT",
    );
  }
}

async function startDownloadsApi(payloadFor, registryPayloadFor = () => null) {
  const requests = [];
  const registryRequests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/downloads\/range\/([^/]+)\/(.+)$/);
    if (match) {
      const period = decodeURIComponent(match[1]);
      const packageName = decodeURIComponent(match[2]);
      requests.push({
        period,
        packageName,
        cacheBust: url.searchParams.get("t") ?? "",
        cacheControl: request.headers["cache-control"],
        pragma: request.headers.pragma,
      });
      const payload = payloadFor({ period, packageName });
      const status = payload?.httpStatus ?? 200;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload?.httpStatus ? payload.body : payload));
      return;
    }

    const packageName = decodeURIComponent(url.pathname.slice(1));
    const payload = registryPayloadFor({ packageName });
    if (payload !== null) {
      registryRequests.push(packageName);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    registryRequests,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    }),
  };
}

function runGenerator(outputDir, apiUrl) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script, "--output-dir", outputDir], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENTPRISM_NPM_DOWNLOADS_API: apiUrl,
        AGENTPRISM_NPM_REGISTRY: apiUrl,
        AGENTPRISM_NPM_DOWNLOADS_NOW: now,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}
