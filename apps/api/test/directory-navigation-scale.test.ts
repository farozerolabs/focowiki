import { describe, expect, it } from "vitest";

import type { ReleaseNavigationEntryRecord } from "../src/application/ports/release-publication-repository.js";
import { writeDirectoryNavigationFiles } from "../src/okf/directory-navigation-files.js";

const CONCEPT_COUNT = 100_000;
const PAGE_SIZE = 500;
const SHARD_ENTRIES = 200;
const SHARD_BYTES = 65_536;

describe("directory navigation scale", () => {
  it("streams a flat 100,000-concept directory into bounded continuation concepts", async () => {
    const evidence = createScaleEvidence([
      "pages/flat/file-000000.md",
      "pages/flat/file-050000.md",
      "pages/flat/file-099999.md"
    ]);
    let sourceLinks = 0;
    let largestMarkdownBytes = 0;
    let generatedFiles = 0;

    await writeDirectoryNavigationFiles({
      generatedAt: "2026-07-13T00:00:00.000Z",
      pageSize: PAGE_SIZE,
      maxEntriesPerPage: SHARD_ENTRIES,
      maxBytesPerPage: SHARD_BYTES,
      fetchEntryPage: async ({ cursor, limit }) => pageFromGenerator(
        cursor,
        limit,
        CONCEPT_COUNT + 1,
        flatEntryAt
      ),
      writeFiles: async (files) => {
        generatedFiles += files.length;
        for (const file of files) {
          evidence.observe(file.logicalPath, file.fileKind, file.content);
          largestMarkdownBytes = Math.max(
            largestMarkdownBytes,
            Buffer.byteLength(file.content, "utf8")
          );
          if (file.fileKind === "directory_index_page") {
            sourceLinks += countMatches(file.content, /\]\(\/pages\/flat\/file-\d{6}\.md\)/gu);
          }
        }
      }
    });

    expect(sourceLinks).toBe(CONCEPT_COUNT);
    expect(largestMarkdownBytes).toBeLessThanOrEqual(SHARD_BYTES);
    expect(generatedFiles).toBeGreaterThan(CONCEPT_COUNT / SHARD_ENTRIES);
    expect(generatedFiles).toBeLessThan(1_000);
    const report = evidence.finish("pages/flat/index.md");
    expect(report.sampledHopDistribution.every((hops) => hops >= 1 && hops <= 4)).toBe(true);
    expect(report.peakRssDeltaBytes).toBeLessThan(128 * 1024 * 1024);
    console.info("OKF flat scale evidence", report);
  }, 30_000);

  it("streams a nested 100,000-concept tree without a corpus-wide navigation array", async () => {
    const directoryCount = 100;
    const conceptsPerDirectory = CONCEPT_COUNT / directoryCount;
    const rootRecordCount = directoryCount + 1;
    const directoryRecordCount = conceptsPerDirectory + 1;
    const recordCount = rootRecordCount + directoryCount * directoryRecordCount;
    const evidence = createScaleEvidence([
      "pages/group-000/file-0000.md",
      "pages/group-050/file-0500.md",
      "pages/group-099/file-0999.md"
    ]);
    let sourceLinks = 0;
    let largestMarkdownBytes = 0;
    let rootDirectoryLinks = 0;

    await writeDirectoryNavigationFiles({
      generatedAt: "2026-07-13T00:00:00.000Z",
      pageSize: PAGE_SIZE,
      maxEntriesPerPage: SHARD_ENTRIES,
      maxBytesPerPage: SHARD_BYTES,
      fetchEntryPage: async ({ cursor, limit }) => pageFromGenerator(
        cursor,
        limit,
        recordCount,
        (index) => nestedEntryAt(index, directoryCount, conceptsPerDirectory)
      ),
      writeFiles: async (files) => {
        for (const file of files) {
          evidence.observe(file.logicalPath, file.fileKind, file.content);
          largestMarkdownBytes = Math.max(
            largestMarkdownBytes,
            Buffer.byteLength(file.content, "utf8")
          );
          sourceLinks += countMatches(file.content, /\]\(\/pages\/group-\d{3}\/file-\d{4}\.md\)/gu);
          if (file.logicalPath === "pages/index.md") {
            rootDirectoryLinks = countMatches(file.content, /\]\(\/pages\/group-\d{3}\/index\.md\)/gu);
          }
        }
      }
    });

    expect(sourceLinks).toBe(CONCEPT_COUNT);
    expect(rootDirectoryLinks).toBe(directoryCount);
    expect(largestMarkdownBytes).toBeLessThanOrEqual(SHARD_BYTES);
    const report = evidence.finish("pages/index.md");
    expect(report.sampledHopDistribution.every((hops) => hops >= 2 && hops <= 5)).toBe(true);
    expect(report.peakRssDeltaBytes).toBeLessThan(128 * 1024 * 1024);
    console.info("OKF nested scale evidence", report);
  }, 30_000);
});

function createScaleEvidence(sampleTargets: string[]) {
  const startedAt = performance.now();
  const baselineRssBytes = process.memoryUsage().rss;
  let peakRssBytes = baselineRssBytes;
  let generatedMarkdownCount = 0;
  let continuationCount = 0;
  let generatedLinkCount = 0;
  let largestMarkdownBytes = 0;
  const sampledTargets = new Set(sampleTargets);
  const navigation = new Map<string, Set<string>>();

  return {
    observe(logicalPath: string, fileKind: string, content: string) {
      generatedMarkdownCount += 1;
      if (fileKind === "directory_index_page" || fileKind === "directory_index_map") {
        continuationCount += 1;
      }
      largestMarkdownBytes = Math.max(largestMarkdownBytes, Buffer.byteLength(content, "utf8"));
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      for (const target of markdownTargets(content)) {
        generatedLinkCount += 1;
        if (isNavigationPath(target) || sampledTargets.has(target)) {
          const targets = navigation.get(logicalPath) ?? new Set<string>();
          targets.add(target);
          navigation.set(logicalPath, targets);
        }
      }
    },
    finish(startPath: string) {
      return {
        conceptCount: CONCEPT_COUNT,
        generatedMarkdownCount,
        continuationCount,
        generatedLinkCount,
        largestMarkdownBytes,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        baselineRssBytes,
        peakRssBytes,
        peakRssDeltaBytes: Math.max(0, peakRssBytes - baselineRssBytes),
        sampledHopDistribution: sampleTargets.map((target) => shortestHopCount(
          navigation,
          startPath,
          target
        ))
      };
    }
  };
}

function markdownTargets(content: string): string[] {
  return Array.from(content.matchAll(/\]\((\/[^)]+)\)/gu), (match) => {
    const target = match[1] ?? "";
    return decodeURIComponent(target.slice(1));
  });
}

function isNavigationPath(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return name === "index.md" || /^(?:index|index-map)-\d{6}\.md$/u.test(name);
}

function shortestHopCount(
  navigation: Map<string, Set<string>>,
  startPath: string,
  targetPath: string
): number {
  const queue = [{ path: startPath, hops: 0 }];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.path)) continue;
    if (current.path === targetPath) return current.hops;
    visited.add(current.path);
    for (const target of navigation.get(current.path) ?? []) {
      queue.push({ path: target, hops: current.hops + 1 });
    }
  }
  return -1;
}

function flatEntryAt(index: number): ReleaseNavigationEntryRecord {
  if (index === 0) {
    return directoryStart("pages/flat", CONCEPT_COUNT);
  }
  const fileIndex = index - 1;
  const name = `file-${String(fileIndex).padStart(6, "0")}.md`;
  return fileEntry("pages/flat", name, `Concept ${fileIndex}`);
}

function nestedEntryAt(
  index: number,
  directoryCount: number,
  conceptsPerDirectory: number
): ReleaseNavigationEntryRecord {
  if (index === 0) {
    return directoryStart("pages", directoryCount);
  }
  if (index <= directoryCount) {
    const directoryIndex = index - 1;
    const name = `group-${String(directoryIndex).padStart(3, "0")}`;
    return {
      id: `directory:${name}`,
      parentPath: "pages",
      kind: "directory",
      name,
      targetPath: `${name}/index.md`,
      label: name,
      entryCount: null,
      directChildCount: conceptsPerDirectory
    };
  }

  const offset = index - directoryCount - 1;
  const blockSize = conceptsPerDirectory + 1;
  const directoryIndex = Math.floor(offset / blockSize);
  const blockOffset = offset % blockSize;
  const directoryName = `group-${String(directoryIndex).padStart(3, "0")}`;
  const parentPath = `pages/${directoryName}`;
  if (blockOffset === 0) {
    return directoryStart(parentPath, conceptsPerDirectory);
  }
  const fileIndex = blockOffset - 1;
  const name = `file-${String(fileIndex).padStart(4, "0")}.md`;
  return fileEntry(parentPath, name, `${directoryName} concept ${fileIndex}`);
}

function directoryStart(parentPath: string, entryCount: number): ReleaseNavigationEntryRecord {
  return {
    id: `start:${parentPath}`,
    parentPath,
    kind: "directory_start",
    name: parentPath.split("/").at(-1) ?? parentPath,
    targetPath: parentPath,
    label: parentPath,
    entryCount
  };
}

function fileEntry(
  parentPath: string,
  name: string,
  title: string
): ReleaseNavigationEntryRecord {
  return {
    id: `file:${parentPath}/${name}`,
    parentPath,
    kind: "file",
    name,
    targetPath: name,
    label: title,
    title,
    description: `Describes ${title}.`,
    entryCount: null,
    directChildCount: null
  };
}

function pageFromGenerator(
  cursor: string | null,
  limit: number,
  count: number,
  entryAt: (index: number) => ReleaseNavigationEntryRecord
): { items: ReleaseNavigationEntryRecord[]; nextCursor: string | null } {
  const start = cursor ? Number(cursor) : 0;
  const end = Math.min(start + limit, count);
  const items = Array.from({ length: end - start }, (_, offset) => entryAt(start + offset));
  return {
    items,
    nextCursor: end < count ? String(end) : null
  };
}

function countMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}
