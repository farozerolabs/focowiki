import { readdirSync } from "node:fs";
import path from "node:path";

export function matchExistingSourceSamples({
  sourceDirectory,
  existingFiles,
  expectedCount
}) {
  if (existingFiles.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} existing source files, got ${existingFiles.length}.`
    );
  }

  const localFilesByBasename = new Map();
  for (const filePath of collectMarkdownFiles(path.resolve(sourceDirectory))) {
    const basename = path.basename(filePath);
    const matches = localFilesByBasename.get(basename) ?? [];
    matches.push(filePath);
    localFilesByBasename.set(basename, matches);
  }

  return existingFiles.map((file) => {
    const matches = localFilesByBasename.get(file.name) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one local Markdown file for ${file.name}, found ${matches.length}.`
      );
    }
    return {
      filePath: matches[0],
      basename: file.name,
      relativePath: file.relativePath
    };
  });
}

function collectMarkdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectMarkdownFiles(entryPath);
    return entry.isFile() && entry.name.toLowerCase().endsWith(".md")
      ? [entryPath]
      : [];
  });
}
