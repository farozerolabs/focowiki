import fs from "node:fs";
import path from "node:path";
import { buildStorageVnextCorpusManifest } from
  "./lib/storage-vnext-corpus-manifest.mjs";
import { readSampleText, selectSamples } from "./lib/sample-selector.mjs";

const EXTERNAL_SAMPLE_COUNT = 200;
const CONTROL_SAMPLE_COUNT = 14;
const DEFAULT_MAX_CANDIDATE_PROFILES = 5_000;
const DEFAULT_OUTPUT_PATH = "tmp/storage-vnext-validation/corpus-manifest.json";
const CONTROL_ROOT = "scripts/validation/fixtures/non-legal-control";

const sourceDir = requiredEnvironment("FOCOWIKI_VALIDATION_MARKDOWN_DIR");
const outputPath = path.resolve(
  process.env.FOCOWIKI_STORAGE_VNEXT_CORPUS_MANIFEST_PATH ?? DEFAULT_OUTPUT_PATH
);
const maxCandidateProfiles = positiveIntegerEnvironment(
  "FOCOWIKI_VALIDATION_MAX_CANDIDATE_PROFILES",
  DEFAULT_MAX_CANDIDATE_PROFILES
);
const externalSelection = selectSamples(sourceDir, EXTERNAL_SAMPLE_COUNT, {
  maxCandidateProfiles
});
const controlSelection = selectSamples(CONTROL_ROOT, CONTROL_SAMPLE_COUNT, {
  maxCandidateProfiles: CONTROL_SAMPLE_COUNT
});
const manifest = buildStorageVnextCorpusManifest({
  createdAt: new Date().toISOString(),
  corpusName: path.basename(path.resolve(sourceDir)),
  totalCandidateFiles: countMarkdownFiles(sourceDir),
  externalSelection,
  controlSelection,
  readText: readSampleText
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  status: "created",
  outputPath: path.relative(process.cwd(), outputPath),
  externalSampleCount: manifest.externalSampleCount,
  genericControlSampleCount: manifest.genericControlSampleCount,
  totalCandidateFiles: manifest.totalCandidateFiles,
  coverage: manifest.coverage
}, null, 2));

function countMarkdownFiles(root) {
  const stack = [path.resolve(root)];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) stack.push(entryPath);
      if (entry.isFile() && entry.name.endsWith(".md")) count += 1;
    }
  }
  return count;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveIntegerEnvironment(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < EXTERNAL_SAMPLE_COUNT) {
    throw new Error(`${name} must be an integer greater than or equal to ${EXTERNAL_SAMPLE_COUNT}.`);
  }
  return parsed;
}
