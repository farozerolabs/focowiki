import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const FILE_ALLOWLIST = new Set([
  "scripts/validation/no-local-path-leaks.mjs"
]);

const PATTERNS = [
  {
    name: "posix-home-path",
    pattern: new RegExp(String.raw`/(Users|home)/[^"'\s` + "`" + String.raw`]+`)
  },
  {
    name: "windows-user-path",
    pattern: new RegExp(String.raw`[A-Za-z]:\\Users\\[^"'\s` + "`" + String.raw`]+`)
  },
  {
    name: "local-validation-data-dir",
    pattern: new RegExp(["official", "flk", "sync"].join("[-_]?"), "i")
  },
  {
    name: "personal-directory-name",
    pattern: /personal directory names/i
  }
];

const files = listGitVisibleFiles();
const findings = [];

for (const file of files) {
  if (FILE_ALLOWLIST.has(file) || shouldSkip(file)) {
    continue;
  }

  const absolute = path.join(ROOT, file);
  const text = safeReadText(absolute);

  if (text === null) {
    continue;
  }

  for (const check of PATTERNS) {
    const match = check.pattern.exec(text);

    if (match) {
      findings.push({
        file,
        check: check.name,
        snippet: redactSnippet(match[0])
      });
    }
  }
}

if (findings.length > 0) {
  console.error(JSON.stringify({ findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log("No local path leaks found in git-visible files.");
}

function listGitVisibleFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: ROOT,
      encoding: "utf8"
    }
  );

  return output.split("\0").filter(Boolean).sort();
}

function shouldSkip(file) {
  return (
    file.startsWith(".git/") ||
    file.startsWith("node_modules/") ||
    file.startsWith(".pnpm-store/") ||
    file.endsWith(".png") ||
    file.endsWith(".jpg") ||
    file.endsWith(".jpeg") ||
    file.endsWith(".gif") ||
    file.endsWith(".webp") ||
    file.endsWith(".ico") ||
    file.endsWith(".lockb")
  );
}

function safeReadText(file) {
  let buffer;

  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  if (buffer.includes(0)) {
    return null;
  }

  return buffer.toString("utf8");
}

function redactSnippet(snippet) {
  if (snippet.includes("/")) {
    return "<redacted-posix-path>";
  }

  if (snippet.includes("\\")) {
    return "<redacted-windows-path>";
  }

  return "<redacted-local-marker>";
}
