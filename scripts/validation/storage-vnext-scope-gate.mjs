#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const allowlistPath = fileURLToPath(
  new URL("./storage-vnext-implementation-allowlist.json", import.meta.url)
);

export const STORAGE_VNEXT_ALLOWLIST = Object.freeze(
  JSON.parse(readFileSync(allowlistPath, "utf8"))
);

const DEPENDENCY_FILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock"
]);

export function classifyStorageVnextPath(path, allowlist = STORAGE_VNEXT_ALLOWLIST) {
  const settingPolicy = allowlist.settingsFieldFiles[path];
  if (settingPolicy) {
    return { policy: "settings-field", category: "approved-settings-field", settingPolicy };
  }

  if (path === "package.json") {
    return { policy: "package-scripts", category: "validation-command" };
  }

  const exception = allowlist.explicitExceptions.find((item) => item.path === path);
  if (exception) {
    return isCompleteTaskException(exception)
      ? { policy: "allow", category: "explicit-task-exception", exception }
      : { policy: "deny", category: "incomplete-task-exception", exception };
  }

  if (allowlist.deniedExact.includes(path)) {
    return { policy: "deny", category: "frozen-generated-structure" };
  }
  if (allowlist.allowedExact.includes(path)) {
    return { policy: "allow", category: "deployment" };
  }
  if (allowlist.deniedPrefixes.some((prefix) => path.startsWith(prefix))) {
    return { policy: "deny", category: deniedPrefixCategory(path) };
  }

  const fileName = path.split("/").at(-1) ?? path;
  if (
    DEPENDENCY_FILE_NAMES.has(fileName)
    || fileName === "package.json"
    || /^README(?:\.[^/]+)?$/u.test(fileName)
  ) {
    return { policy: "deny", category: "dependency-or-documentation" };
  }

  if (allowlist.allowedPrefixes.some((prefix) => path.startsWith(prefix))) {
    return { policy: "allow", category: allowedPrefixCategory(path) };
  }

  return { policy: "deny", category: "unrelated-scope" };
}

export function validateStorageVnextScope(paths, allowlist = STORAGE_VNEXT_ALLOWLIST) {
  return paths.flatMap((path) => {
    const classification = classifyStorageVnextPath(path, allowlist);
    return classification.policy === "deny"
      ? [{ path, reason: `Path is outside the storage vNext allowlist (${classification.category})` }]
      : [];
  });
}

export function validateSettingsFieldPatch(input, allowlist = STORAGE_VNEXT_ALLOWLIST) {
  const policy = allowlist.settingsFieldFiles[input.path];
  if (!policy) {
    return [{ path: input.path, reason: "File is not an approved settings-field source" }];
  }
  if (!input.patch.trim()) {
    return [{ path: input.path, reason: "Changed settings file has no reviewable text patch" }];
  }
  if (
    typeof policy.approvedPatchSha256 === "string"
    && sha256(input.patch) === policy.approvedPatchSha256
  ) {
    return [];
  }

  const baselineSymbols = indexTopLevelSymbols(input.baselineSource);
  const currentSymbols = indexTopLevelSymbols(input.currentSource);
  const allowed = new Set(policy.allowedSymbols);
  const changedLines = readUnifiedChangedLines(input.patch);

  return changedLines.flatMap((change) => {
    const symbols = change.side === "baseline" ? baselineSymbols : currentSymbols;
    const symbol = symbolAtLine(symbols, change.line);
    if (symbol && allowed.has(symbol.name)) return [];
    return [{
      path: input.path,
      reason: `Changed ${change.side} line ${change.line} belongs to ${symbol?.name ?? "no approved top-level symbol"}; only exact settings-field symbols are allowed`
    }];
  });
}

export function validatePackageJsonScope(
  baseline,
  current,
  allowlist = STORAGE_VNEXT_ALLOWLIST
) {
  const failures = [];
  const baselineWithoutScripts = { ...baseline };
  const currentWithoutScripts = { ...current };
  delete baselineWithoutScripts.scripts;
  delete currentWithoutScripts.scripts;
  if (!isDeepStrictEqual(baselineWithoutScripts, currentWithoutScripts)) {
    failures.push({
      path: "package.json",
      reason: "Only storage vNext validation scripts may change; dependencies and package metadata are frozen"
    });
  }

  const baselineScripts = baseline.scripts ?? {};
  const currentScripts = current.scripts ?? {};
  const scriptNames = new Set([...Object.keys(baselineScripts), ...Object.keys(currentScripts)]);
  for (const name of scriptNames) {
    if (name.startsWith("validate:storage-vnext:")) continue;
    if (currentScripts[name] === allowlist.allowedPackageScripts?.[name]) continue;
    if (baselineScripts[name] !== currentScripts[name]) {
      failures.push({
        path: "package.json",
        reason: `Unapproved package script change: ${name}`
      });
    }
  }
  return failures;
}

export function validateStorageVnextWorktree(options = {}) {
  const baselineRef = options.baselineRef ?? STORAGE_VNEXT_ALLOWLIST.baselineRef;
  const paths = listChangedFiles(baselineRef);
  const failures = validateStorageVnextScope(paths);

  for (const path of paths) {
    const classification = classifyStorageVnextPath(path);
    if (classification.policy === "settings-field") {
      failures.push(...validateSettingsFieldPatch({
        path,
        baselineSource: readGitFile(baselineRef, path),
        currentSource: existsSync(path) ? readFileSync(path, "utf8") : "",
        patch: git(["diff", "--unified=0", "--no-ext-diff", baselineRef, "--", path])
      }));
    } else if (classification.policy === "package-scripts") {
      const baseline = JSON.parse(readGitFile(baselineRef, path));
      const current = JSON.parse(readFileSync(path, "utf8"));
      failures.push(...validatePackageJsonScope(baseline, current));
    }
  }

  return { baselineRef, paths, failures };
}

function listChangedFiles(baselineRef) {
  const tracked = git([
    "diff",
    "--name-only",
    "--no-renames",
    baselineRef,
    "--"
  ]).split("\n");
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard"
  ]).split("\n");
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}

function readGitFile(ref, path) {
  return git(["show", `${ref}:${path}`]);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function indexTopLevelSymbols(source) {
  const lines = source.split("\n");
  const starts = [];
  const declaration = /^(?:export\s+)?(?:(?:async|declare)\s+)?(?:const|let|type|interface|class|function)\s+([A-Za-z_$][\w$]*)\b/u;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(declaration);
    if (match) starts.push({ name: match[1], start: index + 1, end: lines.length });
  }
  for (let index = 0; index < starts.length - 1; index += 1) {
    starts[index].end = starts[index + 1].start - 1;
  }
  return starts;
}

function symbolAtLine(symbols, line) {
  return symbols.find((symbol) => line >= symbol.start && line <= symbol.end) ?? null;
}

function readUnifiedChangedLines(patch) {
  const changes = [];
  let baselineLine = 0;
  let currentLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) {
      baselineLine = Number(hunk[1]);
      currentLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("-")) {
      changes.push({ side: "baseline", line: baselineLine });
      baselineLine += 1;
    } else if (line.startsWith("+")) {
      changes.push({ side: "current", line: currentLine });
      currentLine += 1;
    } else if (line.startsWith(" ")) {
      baselineLine += 1;
      currentLine += 1;
    } else if (line.startsWith("diff --git ")) {
      inHunk = false;
    }
  }
  return changes;
}

function deniedPrefixCategory(path) {
  if (path.startsWith("apps/admin/src/")) return "frozen-admin-ui";
  if (path.startsWith("apps/api/src/developer-openapi/") || path.startsWith("apps/api/src/public-openapi/")) {
    return "frozen-public-api-contract";
  }
  if (path.startsWith("apps/api/src/okf/") || path.startsWith("packages/okf/")) {
    return "frozen-generated-structure";
  }
  if (path.startsWith("docs/") || path.startsWith("ReferenceDocs/") || path.startsWith("openspec/")) {
    return "documentation";
  }
  return "unapproved-shared-surface";
}

function allowedPrefixCategory(path) {
  if (path.startsWith("apps/api/test/") || path.startsWith("scripts/validation/")) return "test-or-validation";
  if (
    path.startsWith("deploy/")
    || path.startsWith("scripts/ci/")
    || path.startsWith("scripts/deployment/")
  ) return "deployment";
  return "backend-storage";
}

function isCompleteTaskException(exception) {
  return /^\d+\.\d+$/u.test(exception.taskId ?? "")
    && typeof exception.approvalReference === "string"
    && exception.approvalReference.trim().length > 0
    && typeof exception.reason === "string"
    && exception.reason.trim().length > 0
    && typeof exception.preservedContract === "string"
    && exception.preservedContract.trim().length > 0;
}

function parseCliArgs(argv) {
  const index = argv.indexOf("--baseline");
  if (index < 0) return {};
  const baselineRef = argv[index + 1];
  if (!baselineRef) throw new Error("--baseline requires a Git ref");
  return { baselineRef };
}

function main() {
  const result = validateStorageVnextWorktree(parseCliArgs(process.argv.slice(2)));
  if (result.failures.length > 0) {
    console.error(`Storage vNext scope gate failed against ${result.baselineRef}:`);
    for (const failure of result.failures) {
      console.error(`- ${failure.path}: ${failure.reason}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Storage vNext scope gate passed for ${result.paths.length} changed files against ${result.baselineRef}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
