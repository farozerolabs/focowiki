import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "../..");
const adminDistDir = resolve(rootDir, "apps/admin/dist");

const blockedPatterns = [
  /\bconsole\.log\s*\(/,
  /\bconsole\.debug\s*\(/,
  /\bconsole\.info\s*\(/,
  /\bdebugger\b/
];
const maxJavaScriptChunkBytes = 500_000;

if (!existsSync(adminDistDir)) {
  throw new Error("Admin UI dist directory is missing. Run pnpm --filter @focowiki/admin build first.");
}

const files = listFiles(adminDistDir).filter((file) => /\.(?:js|mjs|cjs)$/.test(file));
const findings = [];
const oversizedChunks = [];

for (const file of files) {
  const contents = readFileSync(file, "utf8");
  const sizeBytes = statSync(file).size;

  if (sizeBytes > maxJavaScriptChunkBytes) {
    oversizedChunks.push(
      `${file.replace(`${rootDir}/`, "")}: ${(sizeBytes / 1_000).toFixed(2)} kB`
    );
  }

  for (const pattern of blockedPatterns) {
    if (pattern.test(contents)) {
      findings.push(`${file.replace(`${rootDir}/`, "")}: ${pattern}`);
    }
  }
}

if (findings.length > 0) {
  throw new Error(`Admin production bundle contains debug output:\n${findings.join("\n")}`);
}

if (oversizedChunks.length > 0) {
  throw new Error(
    `Admin production bundle contains JavaScript chunks larger than 500 kB:\n${oversizedChunks.join("\n")}`
  );
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
