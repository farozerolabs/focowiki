import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "../..");
const adminDistDir = resolve(rootDir, "apps/admin/dist");

const blockedPatterns = [
  /\bconsole\.log\s*\(/,
  /\bconsole\.debug\s*\(/,
  /\bconsole\.info\s*\(/,
  /\bdebugger\b/
];

if (!existsSync(adminDistDir)) {
  throw new Error("Admin UI dist directory is missing. Run pnpm --filter @focowiki/admin build first.");
}

const files = listFiles(adminDistDir).filter((file) => /\.(?:js|mjs|cjs)$/.test(file));
const findings = [];

for (const file of files) {
  const contents = readFileSync(file, "utf8");

  for (const pattern of blockedPatterns) {
    if (pattern.test(contents)) {
      findings.push(`${file.replace(`${rootDir}/`, "")}: ${pattern}`);
    }
  }
}

if (findings.length > 0) {
  throw new Error(`Admin production bundle contains debug output:\n${findings.join("\n")}`);
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
