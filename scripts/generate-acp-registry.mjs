#!/usr/bin/env node
// Build the AgentPrism ACP agent registry published on GitHub Pages.
//
// Metadata is authored below, while versions come from npm's `latest` records.
// The published version must equal the checked-in package version: this prevents
// a Version Packages merge from advertising an artifact before release.yml has
// actually published it. The successful Release workflow triggers the Pages
// workflow again after npm publication.

import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");
const iconDir = join(repoRoot, "docs", "assets");
const defaultIconFile = "agentprism-mark.svg";

const REGISTRY_VERSION = "1.0.0";
const REGISTRY_SITE_PATH = "acp-registry/v1/latest";
const SITE_BASE_URL = "https://agentprism.github.io/agentprism-workflows/";
const NPM_REGISTRY = process.env.AGENTPRISM_ACP_REGISTRY_NPM_API ?? "https://registry.npmjs.org";
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1_000;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// This is the intentional publication allowlist. Discovery below fails if a
// public in-repo `*-acp` agent package is added without a corresponding entry,
// so one cannot be silently omitted from the registry. The transport-routed
// `acp-server` aggregator requires an explicit endpoint selector and therefore
// is not itself one launchable agent registry entry.
const AGENT_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "agentprism-codex-acp",
    name: "AgentPrism Codex ACP",
    package: "@automatalabs/codex-acp",
    bin: "codex-acp",
    description:
      "AgentPrism's Codex ACP fork with turn-level structured output and additional session extensions.",
    repository: "https://github.com/agentprism/agentprism-workflows",
    website:
      "https://github.com/agentprism/agentprism-workflows/tree/main/packages/codex-acp#readme",
    authors: Object.freeze(["Automata Labs"]),
    license: "Apache-2.0",
    license_url: "https://github.com/agentprism/agentprism-workflows/blob/main/LICENSE",
  }),
  Object.freeze({
    id: "agentprism-pi-acp",
    name: "AgentPrism pi ACP",
    package: "@automatalabs/pi-acp",
    bin: "pi-acp",
    description: "AgentPrism's in-process ACP server for the pi coding agent.",
    repository: "https://github.com/agentprism/agentprism-workflows",
    website: "https://github.com/agentprism/agentprism-workflows/tree/main/packages/pi-acp#readme",
    authors: Object.freeze(["Automata Labs"]),
    license: "Apache-2.0",
    license_url: "https://github.com/agentprism/agentprism-workflows/blob/main/LICENSE",
  }),
]);

const outputDir = parseOutputDir(process.argv.slice(2));
const localPackages = await discoverPublishedAcpPackages();
requireCompleteDefinitions(localPackages);
await validateIconSources();

// Finish every network/package validation before creating output. A failed
// refresh therefore cannot leave a plausible but incomplete registry artifact.
const agents = await Promise.all(
  AGENT_DEFINITIONS.map((definition) => buildAgent(definition, localPackages.get(definition.package))),
);
agents.sort((left, right) => left.id.localeCompare(right.id));

// `extensions` is currently empty, but is intentionally present to mirror the
// complete top-level shape published by the official ACP registry.
const registry = { version: REGISTRY_VERSION, agents, extensions: [] };
const registryDir = join(outputDir, ...REGISTRY_SITE_PATH.split("/"));
await mkdir(registryDir, { recursive: true });
await Promise.all([
  writeJson(join(registryDir, "registry.json"), registry),
  ...agents.map((agent) => copyFile(iconSourceFor(agent.id), join(registryDir, `${agent.id}.svg`))),
]);

console.log(
  `acp-registry: wrote ${agents.length} agents to ${join(REGISTRY_SITE_PATH, "registry.json")}`,
);
for (const agent of agents) {
  console.log(`acp-registry: ${agent.id} ${agent.version} (${agent.distribution.npx.package})`);
}

function parseOutputDir(args) {
  if (args.length !== 2 || args[0] !== "--output-dir" || args[1].length === 0) {
    throw new Error("usage: node scripts/generate-acp-registry.mjs --output-dir <directory>");
  }
  return resolve(repoRoot, args[1]);
}

async function discoverPublishedAcpPackages() {
  const discovered = new Map();
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

    if (
      typeof manifest.name !== "string" ||
      !manifest.name.startsWith("@automatalabs/") ||
      !manifest.name.endsWith("-acp") ||
      manifest.private === true
    ) {
      continue;
    }
    if (manifest.publishConfig?.access !== "public") {
      throw new Error(`${manifestPath}: published ACP package must set publishConfig.access to public`);
    }
    if (!SEMVER.test(manifest.version)) {
      throw new Error(`${manifestPath}: version must be an x.y.z semantic version`);
    }
    if (manifest.bin === null || typeof manifest.bin !== "object" || Array.isArray(manifest.bin)) {
      throw new Error(`${manifestPath}: published ACP package must declare an object-valued bin map`);
    }

    discovered.set(manifest.name, { manifest, manifestPath });
  }

  if (discovered.size === 0) throw new Error("no published @automatalabs ACP server packages found");
  return discovered;
}

function requireCompleteDefinitions(localPackages) {
  const configured = AGENT_DEFINITIONS.map((entry) => entry.package).sort();
  const discovered = [...localPackages.keys()].sort();

  if (new Set(configured).size !== configured.length) {
    throw new Error("ACP registry definitions contain a duplicate npm package");
  }
  if (new Set(AGENT_DEFINITIONS.map((entry) => entry.id)).size !== AGENT_DEFINITIONS.length) {
    throw new Error("ACP registry definitions contain a duplicate agent id");
  }
  if (JSON.stringify(configured) !== JSON.stringify(discovered)) {
    throw new Error(
      `ACP registry definitions do not match published ACP packages: configured=${configured.join(", ")} ` +
        `discovered=${discovered.join(", ")}; update AGENT_DEFINITIONS`,
    );
  }
}

async function buildAgent(definition, localPackage) {
  if (!localPackage) throw new Error(`missing local package for ${definition.package}`);
  if (!/^[a-z][a-z0-9-]*$/.test(definition.id)) {
    throw new Error(`invalid ACP registry id: ${definition.id}`);
  }
  if (!(definition.bin in localPackage.manifest.bin)) {
    throw new Error(`${localPackage.manifestPath}: missing expected ${definition.bin} bin`);
  }

  const published = await fetchLatestPackage(definition.package);
  if (published.name !== definition.package) {
    throw new Error(
      `invalid npm latest record for ${definition.package}: name was ${JSON.stringify(published.name)}`,
    );
  }
  if (!SEMVER.test(published.version)) {
    throw new Error(
      `invalid npm latest record for ${definition.package}: version was ${JSON.stringify(published.version)}`,
    );
  }
  if (published.version !== localPackage.manifest.version) {
    throw new Error(
      `${definition.package}: npm latest is ${published.version}, but the checked-in version is ` +
        `${localPackage.manifest.version}; refusing to advertise an unpublished or stale version`,
    );
  }
  if (!publishedBinNames(published.bin).includes(definition.bin)) {
    throw new Error(
      `${definition.package}@${published.version}: published package is missing the ${definition.bin} bin`,
    );
  }

  const icon = new URL(`${REGISTRY_SITE_PATH}/${definition.id}.svg`, SITE_BASE_URL).href;
  return {
    id: definition.id,
    name: definition.name,
    version: published.version,
    description: definition.description,
    repository: definition.repository,
    website: definition.website,
    authors: [...definition.authors],
    license: definition.license,
    license_url: definition.license_url,
    icon,
    distribution: {
      npx: {
        package: `${definition.package}@${published.version}`,
      },
    },
  };
}

async function fetchLatestPackage(packageName) {
  const url = new URL(`${encodeURIComponent(packageName)}/latest`, ensureTrailingSlash(NPM_REGISTRY));
  url.searchParams.set("t", `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  const response = await fetchWithRetry(url);

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`invalid npm JSON for ${packageName}: ${errorMessage(error)}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`invalid npm latest record for ${packageName}: expected an object`);
  }
  return payload;
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
      if (response.status >= 400 && response.status < 500 && response.status !== 429) throw error;
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

function publishedBinNames(bin) {
  if (typeof bin === "string") return [];
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)) return [];
  return Object.keys(bin);
}

async function validateIconSources() {
  const sources = new Set(
    AGENT_DEFINITIONS.map((definition) => join(iconDir, definition.iconFile ?? defaultIconFile)),
  );
  for (const source of sources) {
    const icon = await readFile(source, "utf8");
    if (
      !/<svg\b/.test(icon) ||
      !/\bwidth="16"/.test(icon) ||
      !/\bheight="16"/.test(icon) ||
      !/\bviewBox="0 0 16 16"/.test(icon) ||
      !/currentColor/.test(icon)
    ) {
      throw new Error(`${source}: ACP icon must be a 16x16 currentColor SVG`);
    }
  }
}

function iconSourceFor(agentId) {
  const definition = AGENT_DEFINITIONS.find((entry) => entry.id === agentId);
  if (!definition) throw new Error(`missing ACP registry definition for ${agentId}`);
  return join(iconDir, definition.iconFile ?? defaultIconFile);
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
