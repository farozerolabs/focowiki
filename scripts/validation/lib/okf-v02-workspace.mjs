import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs, { constants as fsConstants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import {
  OKF_V01_COMPATIBILITY_COUNT,
  OKF_V02_PINNED_REVISION,
  buildOkfV02FixtureManifest,
  verifyOkfV02OfficialCheckout
} from "./okf-v02-fixtures.mjs";

const execFileAsync = promisify(execFile);
const OFFICIAL_REPOSITORY_URL =
  "https://github.com/GoogleCloudPlatform/knowledge-catalog.git";
const OWNED_RESOURCE_KINDS = [
  "knowledgeBaseIds",
  "openApiKeyIds",
  "uploadSessionIds",
  "webhookIds",
  "operationIds",
  "searchIndexes",
  "temporaryPaths",
  "evidenceArtifacts"
];

export async function createOkfV02RunWorkspace(input = {}) {
  const runId = validateRunId(input.runId ?? `run-${Date.now()}`);
  const temporaryRoot = path.resolve(input.temporaryRoot ?? os.tmpdir());
  await fs.mkdir(temporaryRoot, { recursive: true });
  const root = await fs.mkdtemp(
    path.join(temporaryRoot, `focowiki-okf-v02-${runId}-`)
  );
  const stagingRoot = path.join(root, "staging");
  await fs.mkdir(stagingRoot, { recursive: true });
  return Object.freeze({
    runId,
    root,
    checkoutRoot: path.join(root, "official-checkout"),
    stagingRoot,
    statePath: path.join(root, "run-state.json")
  });
}

export async function prepareOfficialOkfCheckout(input) {
  const runGit = input.runGit ?? runGitCommand;
  const workspace = validateWorkspace(input.workspace);
  try {
    await runGit([
      "-c",
      "core.hooksPath=/dev/null",
      "clone",
      "--no-checkout",
      OFFICIAL_REPOSITORY_URL,
      workspace.checkoutRoot
    ]);
    await runGit([
      "-C",
      workspace.checkoutRoot,
      "-c",
      "core.hooksPath=/dev/null",
      "checkout",
      "--detach",
      OKF_V02_PINNED_REVISION
    ]);
    const actualRevision = String(await runGit([
      "-C",
      workspace.checkoutRoot,
      "rev-parse",
      "HEAD"
    ])).trim();
    if (actualRevision !== OKF_V02_PINNED_REVISION) {
      throw new Error("The official OKF checkout is not at the pinned revision.");
    }
    return { checkoutRoot: workspace.checkoutRoot, actualRevision };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/pinned revision/u.test(message)) throw error;
    throw new Error(`The official OKF checkout prerequisite failed: ${message}`);
  }
}

export async function discoverOfficialOkfFixtures(checkoutRoot) {
  const bundleRoot = path.join(path.resolve(checkoutRoot), "okf", "bundles");
  const allFiles = await collectReadOnlyFiles(bundleRoot, "official OKF bundle");
  const markdown = allFiles.filter((entry) => entry.relativePath.endsWith(".md"));
  const reserved = markdown.filter((entry) => {
    const basename = path.posix.basename(entry.relativePath);
    return basename === "index.md" || basename === "log.md";
  });
  const concepts = markdown.filter((entry) => !reserved.includes(entry));
  const nonMarkdown = allFiles.filter((entry) => !entry.relativePath.endsWith(".md"));
  verifyOkfV02OfficialCheckout({
    expectedRevision: OKF_V02_PINNED_REVISION,
    actualRevision: OKF_V02_PINNED_REVISION,
    markdownPaths: markdown.map((entry) => entry.relativePath),
    reservedPaths: reserved.map((entry) => entry.relativePath)
  });
  return { bundleRoot, allFiles, markdown, reserved, concepts, nonMarkdown };
}

export async function discoverLegacyOkfFixtures(inputRoot, options = {}) {
  const root = path.resolve(inputRoot);
  const selectCount = options.selectCount ?? OKF_V01_COMPATIBILITY_COUNT;
  const maximumBytes = options.maximumBytes ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(selectCount) || selectCount < OKF_V01_COMPATIBILITY_COUNT) {
    throw new Error("The legacy compatibility selection count is invalid.");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("The legacy compatibility maximum file size is invalid.");
  }
  const allFiles = await collectReadOnlyFiles(root, "legacy compatibility corpus");
  const markdown = allFiles.filter((entry) =>
    entry.relativePath.endsWith(".md")
      && entry.sizeBytes <= maximumBytes
      && !isReservedGeneratedPath(entry.relativePath)
  );
  if (markdown.length < selectCount) {
    throw new Error(`The legacy compatibility corpus must contain at least ${selectCount} safe Markdown files.`);
  }
  return markdown
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .slice(0, selectCount);
}

function isReservedGeneratedPath(relativePath) {
  return new Set([
    "index.md",
    "schema.md",
    "log.md",
    "pages/index.md",
    "_index/index.md",
    "_graph/index.md"
  ]).has(relativePath);
}

export async function stageOkfV02Fixtures(input) {
  const workspace = validateWorkspace(input.workspace);
  const manifest = buildOkfV02FixtureManifest({
    official: input.official,
    legacy: input.legacy
  });
  const sources = new Map([
    ...input.official.map((entry) => [`official/${entry.relativePath}`, entry]),
    ...input.legacy.map((entry) => [`legacy/${entry.relativePath}`, entry])
  ]);
  if (sources.size !== manifest.entries.length) {
    throw new Error("The OKF 0.2 E2E staging source paths contain a duplicate or collision.");
  }
  const stagedFiles = [];
  for (const entry of manifest.entries) {
    const source = sources.get(entry.path);
    if (!source?.sourcePath) {
      throw new Error(`The staged fixture source is missing for ${entry.path}.`);
    }
    await assertFileChecksum(source.sourcePath, source.checksumSha256, "source");
    const stagedPath = safeChildPath(workspace.stagingRoot, entry.path);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    try {
      await fs.copyFile(source.sourcePath, stagedPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await assertFileChecksum(stagedPath, entry.checksumSha256, "staged");
    stagedFiles.push({ ...entry, stagedPath });
  }
  return { manifest, stagedFiles };
}

export async function verifyFixtureFilesUnchanged(files) {
  for (const file of files) {
    await assertFileChecksum(file.sourcePath, file.checksumSha256, "source");
  }
  return true;
}

export function createOkfV02RunOwnership(runId) {
  return {
    runId: validateRunId(runId),
    resources: Object.fromEntries(OWNED_RESOURCE_KINDS.map((kind) => [kind, []]))
  };
}

export function recordOkfV02OwnedResource(ownership, kind, value) {
  if (!OWNED_RESOURCE_KINDS.includes(kind)) {
    throw new Error(`Unsupported E2E resource kind: ${kind}`);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The run-owned ${kind} identifier is invalid.`);
  }
  if (!ownership?.resources || ownership.runId !== validateRunId(ownership.runId)) {
    throw new Error("The OKF 0.2 E2E ownership record is invalid.");
  }
  if (!ownership.resources[kind].includes(value)) {
    ownership.resources[kind].push(value);
  }
  return ownership;
}

export async function openOkfV02RunJournal(workspaceInput) {
  const workspace = validateWorkspace(workspaceInput);
  let state;
  try {
    state = JSON.parse(await fs.readFile(workspace.statePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    state = {
      version: 1,
      runId: workspace.runId,
      phase: "workspace-created",
      completedOperationIds: [],
      ownership: createOkfV02RunOwnership(workspace.runId)
    };
    recordOkfV02OwnedResource(state.ownership, "temporaryPaths", workspace.root);
    await writeJsonAtomic(workspace.statePath, state);
  }
  validateRunState(state, workspace);
  return {
    get state() {
      return structuredClone(state);
    },
    async update(patch) {
      state = { ...state, ...structuredClone(patch) };
      validateRunState(state, workspace);
      await writeJsonAtomic(workspace.statePath, state);
      return structuredClone(state);
    }
  };
}

export async function cleanupOkfV02Workspace(workspaceInput) {
  const workspace = validateWorkspace(workspaceInput);
  const basename = path.basename(workspace.root);
  if (!basename.startsWith(`focowiki-okf-v02-${workspace.runId}-`)) {
    throw new Error("Refusing to clean a directory outside the OKF 0.2 run workspace.");
  }
  await fs.rm(workspace.root, { recursive: true, force: false });
}

async function collectReadOnlyFiles(root, label) {
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`The ${label} directory does not exist.`);
    }
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`The ${label} path is not a directory.`);
  if (stat.isSymbolicLink()) throw new Error(`The ${label} root cannot be a symbolic link.`);
  const records = [];
  await walk(root, "", records, label);
  return records.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walk(root, relativeDirectory, records, label) {
  const directory = relativeDirectory ? path.join(root, relativeDirectory) : root;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(
      relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
    );
    const sourcePath = safeChildPath(root, relativePath);
    if (entry.isSymbolicLink()) {
      throw new Error(`The ${label} contains a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await walk(root, relativePath, records, label);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`The ${label} contains an unsupported file type: ${relativePath}`);
    }
    const fileStat = await fs.stat(sourcePath);
    records.push({
      sourcePath,
      relativePath,
      checksumSha256: await hashFile(sourcePath),
      sizeBytes: fileStat.size
    });
  }
}

async function assertFileChecksum(file, expected, label) {
  const actual = await hashFile(file);
  if (actual !== expected) {
    throw new Error(`The ${label} fixture checksum changed.`);
  }
}

async function hashFile(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function safeChildPath(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const target = path.resolve(root, ...normalized.split("/"));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix)) {
    throw new Error("The fixture path escapes its owned root.");
  }
  return target;
}

function normalizeRelativePath(value) {
  if (typeof value !== "string") throw new Error("Fixture path must be a string.");
  const normalized = value.normalize("NFC").replaceAll("\\", "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    throw new Error("Fixture path is not a safe normalized relative path.");
  }
  return normalized;
}

function validateWorkspace(workspace) {
  if (
    !workspace
    || typeof workspace.root !== "string"
    || typeof workspace.runId !== "string"
    || typeof workspace.checkoutRoot !== "string"
    || typeof workspace.stagingRoot !== "string"
    || typeof workspace.statePath !== "string"
  ) {
    throw new Error("The OKF 0.2 E2E workspace is invalid.");
  }
  validateRunId(workspace.runId);
  return workspace;
}

function validateRunState(state, workspace) {
  if (
    !state
    || state.version !== 1
    || state.runId !== workspace.runId
    || typeof state.phase !== "string"
    || !Array.isArray(state.completedOperationIds)
  ) {
    throw new Error("The OKF 0.2 E2E run state is invalid.");
  }
}

function validateRunId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(value)) {
    throw new Error("The OKF 0.2 E2E run ID is invalid.");
  }
  return value;
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function runGitCommand(args) {
  const { stdout } = await execFileAsync("git", args, {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat"
    },
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}
