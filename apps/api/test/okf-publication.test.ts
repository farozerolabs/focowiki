import { describe, expect, it } from "vitest";
import { publishOkfRelease, type BundleFileDraft, type BundleTreeEntryDraft } from "../src/okf/publication.js";
import { createStorageKeyspace, type StorageKeyspace } from "../src/storage/keys.js";
import type { StoredObject } from "../src/storage/s3.js";

type SourceRecord = {
  id: string;
  originalName: string;
  objectKey: string;
  metadata: {
    type: string;
    title: string;
  };
};

function sourceRecord(id: string, originalName: string, objectKey: string): SourceRecord {
  return {
    id,
    originalName,
    objectKey,
    metadata: {
      type: "page",
      title: originalName.replace(/\.md$/, "")
    }
  };
}

class PublicationStorage {
  public readonly keyspace: StorageKeyspace = createStorageKeyspace("tenant/demo");
  public readonly objects = new Map<string, string>();
  public readonly written: StoredObject[] = [];
  public activeReads = 0;
  public maxActiveReads = 0;

  public constructor(sources: SourceRecord[]) {
    for (const source of sources) {
      this.objects.set(
        source.objectKey,
        `---\ntype: page\ntitle: ${source.originalName.replace(/\.md$/, "")}\n---\n# ${source.originalName}`
      );
    }
  }

  public async getObjectText(key: string): Promise<string | null> {
    this.activeReads += 1;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.activeReads -= 1;
    return this.objects.get(key) ?? null;
  }

  public async putObject(object: StoredObject): Promise<void> {
    this.written.push(object);
    this.objects.set(
      object.key,
      typeof object.body === "string" ? object.body : new TextDecoder().decode(object.body)
    );
  }
}

describe("publishOkfRelease", () => {
  it("reads source records through cursor pages and publishes bounded release records", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-001", "intro.md", "tenant/demo/source/intro.md"),
      sourceRecord("source-002", "setup.md", "tenant/demo/source/setup.md")
    ];
    const fetchCalls: Array<{ cursor: string | null; limit: number }> = [];
    const fileBatches: BundleFileDraft[][] = [];
    const treeBatches: BundleTreeEntryDraft[][] = [];
    const storage = new PublicationStorage(sources);

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      releaseId: "release-001",
      taskId: "task-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      pageSize: 1,
      concurrency: 1,
      storage,
      fetchSourcePage: async ({ cursor, limit }) => {
        fetchCalls.push({ cursor, limit });
        const start = cursor ? Number(cursor) : 0;
        const items = sources.slice(start, start + limit);
        const nextCursor = start + limit < sources.length ? String(start + limit) : null;
        return { items, nextCursor };
      },
      persistBundleFiles: async (files) => {
        fileBatches.push(files);
      },
      persistBundleTreeEntries: async (entries) => {
        treeBatches.push(entries);
      }
    });

    expect(fetchCalls).toEqual([
      { cursor: null, limit: 1 },
      { cursor: "1", limit: 1 }
    ]);
    expect(storage.maxActiveReads).toBeLessThanOrEqual(1);
    expect(result.fileCount).toBe(9);
    expect(result.bundleRootKey).toBe("tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/");
    expect(storage.objects.get(`${result.bundleRootKey}index.md`)).toContain("[intro](/pages/intro.md)");
    expect(storage.objects.get(`${result.bundleRootKey}_index/manifest.json`)).toContain(
      "\"pages/intro.md\""
    );
    expect(fileBatches.every((batch) => batch.length <= 1)).toBe(true);
    expect(treeBatches.every((batch) => batch.length <= 1)).toBe(true);
    expect(fileBatches.flat().map((file) => file.logicalPath).sort()).toEqual([
      "_index/links.json",
      "_index/manifest.json",
      "_index/search.json",
      "index.md",
      "pages/intro.md",
      "pages/setup.md",
      "schema.md",
      "sources/intro.md",
      "sources/setup.md"
    ]);
    expect(treeBatches.flat()).toContainEqual(
      expect.objectContaining({
        parentPath: "pages",
        name: "intro.md",
        logicalPath: "pages/intro.md",
        entryType: "file",
        bundleFileId: expect.stringMatching(/^bundle-file-/)
      })
    );
  });

  it("keeps original Markdown file names in public bundle paths", async () => {
    const sourceName = "外国企业常驻代表机构登记管理条例.md";
    const sources: SourceRecord[] = [
      sourceRecord("source-001", sourceName, "tenant/demo/source/original.md")
    ];
    const fileBatches: BundleFileDraft[][] = [];
    const treeBatches: BundleTreeEntryDraft[][] = [];
    const storage = new PublicationStorage(sources);

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      releaseId: "release-001",
      taskId: "task-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      defaults: {},
      pageSize: 50,
      concurrency: 1,
      storage,
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async (files) => {
        fileBatches.push(files);
      },
      persistBundleTreeEntries: async (entries) => {
        treeBatches.push(entries);
      }
    });

    const pagePath = `pages/${sourceName}`;
    const sourcePath = `sources/${sourceName}`;

    expect(fileBatches.flat().map((file) => file.logicalPath)).toEqual(
      expect.arrayContaining([pagePath, sourcePath])
    );
    expect(treeBatches.flat()).toContainEqual(
      expect.objectContaining({
        parentPath: "pages",
        name: sourceName,
        logicalPath: pagePath,
        entryType: "file"
      })
    );
    expect(storage.objects.get(`${result.bundleRootKey}index.md`)).toContain(
      `[外国企业常驻代表机构登记管理条例](/pages/${encodeURIComponent(sourceName)})`
    );
    expect(storage.objects.get(`${result.bundleRootKey}_index/manifest.json`)).toContain(
      `"${pagePath}"`
    );
  });

  it("fails before persistence when generated files violate OKF conformance", async () => {
    const sources: SourceRecord[] = [
      {
        id: "source-001",
        originalName: "intro.md",
        objectKey: "tenant/demo/source/intro.md",
        metadata: {
          type: "",
          title: ""
        }
      }
    ];
    const storage = new PublicationStorage(sources);
    storage.objects.set("tenant/demo/source/intro.md", "# Missing metadata");
    const persistedFiles: BundleFileDraft[] = [];

    await expect(
      publishOkfRelease({
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        taskId: "task-001",
        generatedAt: "2026-06-14T00:00:00.000Z",
        defaults: {},
        pageSize: 1,
        concurrency: 1,
        storage,
        fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
        persistBundleFiles: async (files) => {
          persistedFiles.push(...files);
        },
        persistBundleTreeEntries: async () => undefined
      })
    ).rejects.toThrow(/type is required|title is required/i);

    expect(persistedFiles).toEqual([]);
  });
});
