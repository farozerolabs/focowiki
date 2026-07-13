import { describe, expect, it } from "vitest";

import type { ReleaseNavigationEntryRecord } from "../src/application/ports/release-publication-repository.js";
import { writeDirectoryNavigationFiles } from "../src/okf/directory-navigation-files.js";
import type { GeneratedOkfFile } from "../src/okf/publication-files.js";

const GENERATED_AT = "2026-07-10T00:00:00.000Z";

describe("writeDirectoryNavigationFiles", () => {
  it("writes one bounded reserved index for an empty directory", async () => {
    const files = await writeNavigation([
      directoryStart("pages/empty", 0)
    ]);

    expect(files).toEqual([
      expect.objectContaining({
        logicalPath: "pages/empty/index.md",
        fileKind: "directory_index",
        content: "# empty\n\n\n"
      })
    ]);
  });

  it("preserves nested Unicode paths and equal basenames in different directories", async () => {
    const files = await writeNavigation([
      directoryStart("pages", 2),
      directory("pages", "中文", "中文", "中文"),
      directory("pages", "English", "English", "English"),
      directoryStart("pages/English", 1),
      file("pages/English", "guide.md", "guide.md", "guide", {
        title: "English guide",
        description: "Explains the English workflow."
      }),
      directoryStart("pages/中文", 1),
      file("pages/中文", "guide.md", "guide.md", "中文指南")
    ]);

    expect(contentAt(files, "pages/index.md")).toContain(
      "[中文](/pages/%E4%B8%AD%E6%96%87/index.md) - Browse this directory."
    );
    expect(contentAt(files, "pages/English/index.md")).toContain(
      "[English guide](/pages/English/guide.md) - Explains the English workflow."
    );
    expect(contentAt(files, "pages/中文/index.md")).toContain(
      "[中文指南](/pages/%E4%B8%AD%E6%96%87/guide.md) - Read this Markdown concept."
    );
  });

  it("uses canonical metadata and deterministic duplicate-title discriminators", async () => {
    const files = await writeNavigation([
      directoryStart("pages/releases", 2),
      file("pages/releases", "guide-v1.md", "guide-v1.md", "guide-v1", {
        title: "Operations guide",
        description: "Documents the first rollout process.",
        timestamp: "2026-06-01T00:00:00Z",
        duplicateTitleCount: 2
      }),
      file("pages/releases", "guide-v2.md", "guide-v2.md", "guide-v2", {
        title: "Operations guide",
        description: "Documents the revised rollout process.",
        version: "2.0",
        duplicateTitleCount: 2
      })
    ]);

    const content = contentAt(files, "pages/releases/index.md");
    expect(content).toContain(
      "[Operations guide (2026-06-01)](/pages/releases/guide-v1.md) - Documents the first rollout process."
    );
    expect(content).toContain(
      "[Operations guide (2.0)](/pages/releases/guide-v2.md) - Documents the revised rollout process."
    );
  });

  it("falls back to filename discriminators when duplicate titles share a timestamp", async () => {
    const files = await writeNavigation([
      directoryStart("pages/releases", 2),
      file("pages/releases", "guide__2026-06-01__alpha.md", "guide__2026-06-01__alpha.md", "guide", {
        title: "Operations guide",
        timestamp: "2026-06-01T00:00:00Z",
        duplicateTitleCount: 2,
        duplicateTimestampCount: 2
      }),
      file("pages/releases", "guide__2026-06-01__beta.md", "guide__2026-06-01__beta.md", "guide", {
        title: "Operations guide",
        timestamp: "2026-06-01T00:00:00Z",
        duplicateTitleCount: 2,
        duplicateTimestampCount: 2
      })
    ]);

    const content = contentAt(files, "pages/releases/index.md");
    expect(content).toContain(
      "[Operations guide (alpha)](/pages/releases/guide__2026-06-01__alpha.md)"
    );
    expect(content).toContain(
      "[Operations guide (beta)](/pages/releases/guide__2026-06-01__beta.md)"
    );
  });

  it("describes child directories with their direct entry counts", async () => {
    const files = await writeNavigation([
      directoryStart("pages", 1),
      directory("pages", "team", "team/index.md", "team", 12)
    ]);

    expect(contentAt(files, "pages/index.md")).toContain(
      "[team](/pages/team/index.md) - Contains 12 direct entries."
    );
  });

  it("shards by byte budget and links every direct entry exactly once", async () => {
    const entries = [
      file("pages/large", "alpha.md", "alpha.md", "Alpha entry with a long description"),
      file("pages/large", "beta.md", "beta.md", "Beta entry with a long description"),
      file("pages/large", "gamma.md", "gamma.md", "Gamma entry with a long description")
    ];
    const files = await writeNavigation([
      directoryStart("pages/large", entries.length),
      ...entries
    ], { maxEntriesPerPage: 100, maxBytesPerPage: 70, fetchPageSize: 2 });

    const entryPages = files.filter((item) => item.fileKind === "directory_index_page");
    expect(entryPages.length).toBeGreaterThan(1);
    expect(entryPages[0]).toMatchObject({
      logicalPath: "pages/large/index-000001.md",
      metadata: {
        type: "Directory Index Page",
        title: "large index page 1",
        description: "Entries 1 through 1 for pages/large."
      }
    });
    expect(entryPages[0]?.content).toContain('type: "Directory Index Page"');
    expect(entryPages[0]?.content).toContain('title: "large index page 1"');
    expect(entryPages[0]?.content).toContain("# large index page 1");
    const rootIndex = contentAt(files, "pages/large/index.md");
    expect(rootIndex).toMatch(/index-(?:map-)?000001\.md/u);
    expect(files.some((item) => item.fileKind === "directory_index_map")).toBe(true);

    const combined = entryPages.map((item) => item.content).join("\n");
    for (const entry of entries) {
      expect(combined.match(new RegExp(`\\(/pages/large/${entry.targetPath}\\)`, "gu")))
        .toHaveLength(1);
    }
  });

  it("rejects a navigation stream whose declared count changes", async () => {
    await expect(writeNavigation([
      directoryStart("pages/incomplete", 2),
      file("pages/incomplete", "one.md", "one.md", "One")
    ])).rejects.toThrow(/count changed/);
  });
});

async function writeNavigation(
  entries: ReleaseNavigationEntryRecord[],
  options: {
    maxEntriesPerPage?: number;
    maxBytesPerPage?: number;
    fetchPageSize?: number;
  } = {}
): Promise<GeneratedOkfFile[]> {
  const written: GeneratedOkfFile[] = [];
  return writeDirectoryNavigationFiles({
    generatedAt: GENERATED_AT,
    pageSize: options.fetchPageSize ?? 100,
    ...(options.maxEntriesPerPage === undefined
      ? {}
      : { maxEntriesPerPage: options.maxEntriesPerPage }),
    ...(options.maxBytesPerPage === undefined
      ? {}
      : { maxBytesPerPage: options.maxBytesPerPage }),
    fetchEntryPage: async ({ cursor, limit }) => {
      const offset = cursor ? Number(cursor) : 0;
      const items = entries.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor: nextOffset < entries.length ? String(nextOffset) : null
      };
    },
    writeFiles: async (files) => {
      written.push(...files);
    }
  }).then(() => written);
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

function directory(
  parentPath: string,
  name: string,
  targetPath: string,
  label: string,
  directChildCount: number | null = null
): ReleaseNavigationEntryRecord {
  return {
    id: `directory:${parentPath}/${name}`,
    parentPath,
    kind: "directory",
    name,
    targetPath,
    label,
    entryCount: null,
    directChildCount
  };
}

function file(
  parentPath: string,
  name: string,
  targetPath: string,
  label: string,
  presentation: Partial<Pick<
    ReleaseNavigationEntryRecord,
    | "title"
    | "description"
    | "timestamp"
    | "version"
    | "duplicateTitleCount"
    | "duplicateTimestampCount"
  >> = {}
): ReleaseNavigationEntryRecord {
  return {
    id: `file:${parentPath}/${name}`,
    parentPath,
    kind: "file",
    name,
    targetPath,
    label,
    entryCount: null,
    directChildCount: null,
    ...presentation
  };
}

function contentAt(files: GeneratedOkfFile[], path: string): string {
  const file = files.find((item) => item.logicalPath === path);
  expect(file, `Missing generated file ${path}`).toBeDefined();
  return file?.content ?? "";
}
