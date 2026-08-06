#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  buildStorageVnextScaleCorpusManifest,
  STORAGE_VNEXT_SCALE_FILE_COUNT
} from "./lib/storage-vnext-scale-corpus.mjs";
import { selectSamples } from "./lib/sample-selector.mjs";

const FORMAL_DIRECTORIES = new Set([
  "01_宪法",
  "02_法律",
  "03_行政法规",
  "04_监察法规",
  "05_地方法规",
  "06_司法解释"
]);
const FULL_CORPUS_FILE_COUNT = 29_736;
const FULL_CORPUS_SIZE_BYTES = 526_803_253;

const sourceRoot = path.resolve(requiredEnvironment("FOCOWIKI_VALIDATION_MARKDOWN_DIR"));
const mode = process.env.FOCOWIKI_STORAGE_VNEXT_CORPUS_MODE?.trim() || "scale";
if (mode !== "scale" && mode !== "full") {
  throw new Error("Storage vNext corpus mode must be scale or full");
}
const selectedFileCount = mode === "full"
  ? FULL_CORPUS_FILE_COUNT
  : STORAGE_VNEXT_SCALE_FILE_COUNT;
const outputPath = path.resolve(
  requiredEnvironment(mode === "full"
    ? "FOCOWIKI_STORAGE_VNEXT_FULL_CORPUS_PATH"
    : "FOCOWIKI_STORAGE_VNEXT_SCALE_CORPUS_PATH")
);
const formalFiles = collectFormalMarkdownFiles(sourceRoot);
const totalCandidateFiles = formalFiles.length;
const selection = mode === "full"
  ? {
      samples: formalFiles,
      coverage: { completeFormalCorpus: true }
    }
  : selectSamples(sourceRoot, selectedFileCount, {
      maxCandidateProfiles: totalCandidateFiles
    });
if (selection.samples.some((sample) =>
  !FORMAL_DIRECTORIES.has(sample.relativePath.split("/")[0]))) {
  throw new Error("Scale corpus selection escaped the formal 01-06 directory boundary");
}
const manifest = buildStorageVnextScaleCorpusManifest({
  createdAt: new Date().toISOString(),
  corpusName: path.basename(sourceRoot),
  totalCandidateFiles,
  expectedFileCount: selectedFileCount,
  selectionStrategy: mode === "full"
    ? "complete-formal-corpus-v1"
    : "deterministic-metadata-coverage-v1",
  samples: selection.samples,
  readBytes: (sample) => fs.readFileSync(sample.filePath)
});
if (mode === "full" && manifest.totalSizeBytes !== FULL_CORPUS_SIZE_BYTES) {
  throw new Error(
    `Formal corpus byte identity changed: ${manifest.totalSizeBytes}/${FULL_CORPUS_SIZE_BYTES}`
  );
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
  flag: "wx"
});
process.stdout.write(`${JSON.stringify({
  status: "created",
  outputPath,
  fileCount: manifest.fileCount,
  totalSizeBytes: manifest.totalSizeBytes,
  totalCandidateFiles,
  manifestChecksumSha256: manifest.manifestChecksumSha256,
  coverage: selection.coverage
}, null, 2)}\n`);

function collectFormalMarkdownFiles(root) {
  const files = [];
  for (const directory of FORMAL_DIRECTORIES) {
    const stack = [path.join(root, directory)];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".")) stack.push(entryPath);
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push({
            filePath: entryPath,
            relativePath: path.relative(root, entryPath).split(path.sep).join("/"),
            sizeBytes: fs.statSync(entryPath).size
          });
        }
      }
    }
  }
  if (files.length !== FULL_CORPUS_FILE_COUNT) {
    throw new Error(
      `Formal corpus identity changed: ${files.length}/${FULL_CORPUS_FILE_COUNT} Markdown files`
    );
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
