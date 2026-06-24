import { describe, expect, it } from "vitest";
import { publishOkfRelease, type BundleFileDraft, type BundleTreeEntryDraft } from "../src/okf/publication.js";
import { createStorageKeyspace, type StorageKeyspace } from "../src/storage/keys.js";
import type { StoredObject } from "../src/storage/s3.js";
import type { SourceMetadataDefaults } from "@focowiki/okf";

type SourceRecord = {
  id: string;
  originalName: string;
  objectKey: string;
  metadata: SourceMetadataDefaults;
  suggestions?: {
    description: string;
    title: string;
    type: string;
    tags: string[];
    related_links: Array<{ title: string; path: string }>;
    keywords: string[];
  } | null;
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
  public readonly readKeys: string[] = [];
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
    this.readKeys.push(key);
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
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
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
      { cursor: "1", limit: 1 },
      { cursor: null, limit: 1 },
      { cursor: "1", limit: 1 }
    ]);
    expect(storage.maxActiveReads).toBeLessThanOrEqual(1);
    expect(result.fileCount).toBe(8);
    expect(result.bundleRootKey).toBe("tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/");
    expect(storage.objects.get(`${result.bundleRootKey}index.md`)).toContain("# Developer docs");
    expect(storage.objects.get(`${result.bundleRootKey}index.md`)).toContain("[intro](/pages/intro.md)");
    expect(storage.objects.get(`${result.bundleRootKey}log.md`)).toContain("# Directory Update Log");
    expect(storage.objects.get(`${result.bundleRootKey}log.md`)).toContain("Published 2 Markdown pages");
    expect(storage.objects.get(`${result.bundleRootKey}log.md`)).toContain("[intro](/pages/intro.md)");
    expect(storage.objects.get(`${result.bundleRootKey}_index/manifest.json`)).toContain(
      "\"pages/intro.md\""
    );
    expect(storage.objects.get(`${result.bundleRootKey}_index/manifest.json`)).toContain(
      "\"log.md\""
    );
    expect(storage.objects.get(`${result.bundleRootKey}_index/manifest.json`)).toContain(
      "\"Developer docs schema\""
    );
    expect(fileBatches.every((batch) => batch.length <= 1)).toBe(true);
    expect(treeBatches.every((batch) => batch.length <= 1)).toBe(true);
    expect(fileBatches.flat().map((file) => file.logicalPath).sort()).toEqual([
      "_index/links.json",
      "_index/manifest.json",
      "_index/search.json",
      "index.md",
      "log.md",
      "pages/intro.md",
      "pages/setup.md",
      "schema.md"
    ]);
    expect(fileBatches.flat()).toContainEqual(
      expect.objectContaining({
        logicalPath: "pages/intro.md",
        sourceFileId: "source-001",
        fileKind: "page"
      })
    );
    expect(fileBatches.flat()).toContainEqual(
      expect.objectContaining({
        logicalPath: "index.md",
        sourceFileId: null,
        fileKind: "index"
      })
    );
    expect(fileBatches.flat()).toContainEqual(
      expect.objectContaining({
        logicalPath: "log.md",
        sourceFileId: null,
        fileKind: "log"
      })
    );
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

  it("publishes duplicate original filenames with unique public paths", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-001", "guide.md", "tenant/demo/source/guide-1.md"),
      sourceRecord("source-002", "guide.md", "tenant/demo/source/guide-2.md")
    ];
    const fileBatches: BundleFileDraft[][] = [];
    const treeBatches: BundleTreeEntryDraft[][] = [];
    const storage = new PublicationStorage(sources);

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 10,
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

    const logicalPaths = fileBatches.flat().map((file) => file.logicalPath).sort();
    expect(result.fileCount).toBe(8);
    expect(logicalPaths).toContain("pages/guide.md");
    expect(logicalPaths).toContain("pages/guide--source-002.md");
    expect(storage.objects.get(`${result.bundleRootKey}index.md`)).toContain("[guide](/pages/guide.md)");
    expect(storage.objects.get(`${result.bundleRootKey}index.md`)).toContain(
      "[guide](/pages/guide--source-002.md)"
    );
    expect(treeBatches.flat().map((entry) => entry.logicalPath)).toContain("pages/guide--source-002.md");
  });

  it("copies unchanged page object references from the previous release", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-001", "intro.md", "tenant/demo/source/intro.md"),
      sourceRecord("source-002", "setup.md", "tenant/demo/source/setup.md")
    ];
    const storage = new PublicationStorage(sources);
    const persistedFiles: BundleFileDraft[] = [];

    await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-002",
      generatedAt: "2026-06-14T00:10:00.000Z",
      pageSize: 10,
      concurrency: 1,
      storage,
      dirtySourceFileIds: ["source-002"],
      fetchPreviousBundleFilePage: async () => ({
        items: [
          {
            sourceFileId: "source-001",
            fileKind: "page",
            logicalPath: "pages/intro.md",
            objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
            contentType: "text/markdown; charset=utf-8",
            sizeBytes: 128,
            checksumSha256: "previous-checksum",
            okfType: "page",
            title: "Intro",
            description: "Copied intro page",
            tags: ["intro"],
            frontmatter: {
              type: "page",
              title: "Intro",
              description: "Copied intro page",
              tags: ["intro"]
            }
          }
        ],
        nextCursor: null
      }),
      fetchGraphEdgePage: async () => ({
        items: [
          {
            fromFileId: "source-001",
            toFileId: "source-002",
            relationType: "shared_subject",
            weight: 0.72,
            reason: "Intro and setup share a subject.",
            source: "deterministic",
            evidence: { signal: "shared_subject" }
          }
        ],
        nextCursor: null
      }),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async (files) => {
        persistedFiles.push(...files);
      },
      persistBundleTreeEntries: async () => undefined
    });

    expect(storage.readKeys).toEqual(["tenant/demo/source/setup.md"]);
    expect(persistedFiles).toContainEqual(
      expect.objectContaining({
        sourceFileId: "source-001",
        logicalPath: "pages/intro.md",
        objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
        checksumSha256: "previous-checksum"
      })
    );
    expect(persistedFiles).toContainEqual(
      expect.objectContaining({
        sourceFileId: "source-002",
        logicalPath: "pages/setup.md",
        objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-002/bundle/pages/setup.md"
      })
    );
    const links = JSON.parse(
      storage.objects.get(
        "tenant/demo/knowledge-bases/kb-001/releases/release-002/bundle/_index/links.json"
      ) ?? "{}"
    ) as { links?: Array<{ from: string; to: string; label: string }> };
    expect(links.links).toContainEqual(
      expect.objectContaining({
        from: "pages/intro.md",
        to: "pages/setup.md",
        label: "setup"
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
      knowledgeBaseName: "Legal docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
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
    expect(fileBatches.flat().map((file) => file.logicalPath)).toEqual(
      expect.arrayContaining([pagePath])
    );
    expect(fileBatches.flat().map((file) => file.logicalPath)).not.toContain(
      `sources/${sourceName}`
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
    expect(storage.objects.get(`${result.bundleRootKey}index.md`)).toContain("# Legal docs");
    expect(storage.objects.get(`${result.bundleRootKey}_index/manifest.json`)).toContain(
      `"${pagePath}"`
    );
  });

  it("publishes generic and pass-through frontmatter metadata into JSON indexes", async () => {
    const sources: SourceRecord[] = [
      {
        id: "source-001",
        originalName: "legal-rule.md",
        objectKey: "tenant/demo/source/legal-rule.md",
        metadata: {
          type: "regulation",
          title: "Legal rule",
          description: "Factual rule description",
          resource: "https://example.com/legal-rule",
          timestamp: "2026-06-14T00:00:00.000Z",
          tags: ["legal", "rule"],
          officialId: "law-001",
          status: "active",
          jurisdiction: "example",
          objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/legal-rule.md",
          releaseId: "release-001",
          localPath: "/private/tmp/legal-rule.md",
          providerPayload: {
            id: "provider-output"
          }
        }
      }
    ];
    const storage = new PublicationStorage(sources);

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Legal docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 50,
      concurrency: 1,
      storage,
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async () => undefined,
      persistBundleTreeEntries: async () => undefined
    });

    const manifest = JSON.parse(
      storage.objects.get(`${result.bundleRootKey}_index/manifest.json`) ?? "{}"
    ) as {
      files: Array<{ path: string; metadata?: Record<string, unknown> }>;
    };
    const search = JSON.parse(
      storage.objects.get(`${result.bundleRootKey}_index/search.json`) ?? "{}"
    ) as {
      items: Array<{
        path: string;
        type?: string;
        title: string;
        description?: string;
        resource?: string;
        timestamp?: string;
        tags: string[];
        metadata?: Record<string, unknown>;
      }>;
    };

    const manifestPage = manifest.files.find((file) => file.path === "pages/legal-rule.md");
    expect(manifestPage?.metadata).toMatchObject({
      type: "regulation",
      title: "Legal rule",
      description: "Factual rule description",
      resource: "https://example.com/legal-rule",
      timestamp: "2026-06-14T00:00:00.000Z",
      tags: ["legal", "rule"],
      officialId: "law-001",
      status: "active",
      jurisdiction: "example"
    });
    expect(manifestPage?.metadata).not.toHaveProperty("objectKey");
    expect(manifestPage?.metadata).not.toHaveProperty("releaseId");
    expect(manifestPage?.metadata).not.toHaveProperty("taskId");
    expect(manifestPage?.metadata).not.toHaveProperty("localPath");
    expect(manifestPage?.metadata).not.toHaveProperty("providerPayload");

    expect(search.items).toContainEqual(
      expect.objectContaining({
        path: "pages/legal-rule.md",
        type: "regulation",
        title: "Legal rule",
        description: "Factual rule description",
        resource: "https://example.com/legal-rule",
        timestamp: "2026-06-14T00:00:00.000Z",
        tags: ["legal", "rule"],
        metadata: expect.objectContaining({
          officialId: "law-001",
          status: "active",
          jurisdiction: "example"
        })
      })
    );
    const searchPage = search.items.find((item) => item.path === "pages/legal-rule.md");
    expect(searchPage?.metadata).not.toHaveProperty("objectKey");
    expect(searchPage?.metadata).not.toHaveProperty("releaseId");
    expect(searchPage?.metadata).not.toHaveProperty("taskId");
    expect(searchPage?.metadata).not.toHaveProperty("localPath");
    expect(searchPage?.metadata).not.toHaveProperty("providerPayload");
  });

  it("shards large index files with bounded JSONL entries", async () => {
    const sources: SourceRecord[] = Array.from({ length: 3 }, (_value, index) =>
      sourceRecord(
        `source-${index + 1}`,
        `guide-${index + 1}.md`,
        `tenant/demo/source/guide-${index + 1}.md`
      )
    );
    const storage = new PublicationStorage(sources);
    const persistedFiles: BundleFileDraft[] = [];

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 3,
      concurrency: 1,
      indexShardSize: 2,
      linkIndexShardSize: 2,
      manifestShardSize: 2,
      storage,
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async (files) => {
        persistedFiles.push(...files);
      },
      persistBundleTreeEntries: async () => undefined
    });

    const searchDescriptor = JSON.parse(
      storage.objects.get(`${result.bundleRootKey}_index/search.json`) ?? "{}"
    ) as {
      mode: string;
      item_count: number;
      shard_size: number;
      shards: Array<{ path: string; count: number }>;
    };
    const manifestDescriptor = JSON.parse(
      storage.objects.get(`${result.bundleRootKey}_index/manifest.json`) ?? "{}"
    ) as {
      mode: string;
      shards: Array<{ path: string; count: number }>;
    };

    expect(searchDescriptor).toMatchObject({
      mode: "sharded",
      item_count: 3,
      shard_size: 2,
      shards: [
        { path: "_index/search/000001.jsonl", count: 2 },
        { path: "_index/search/000002.jsonl", count: 1 }
      ]
    });
    expect(manifestDescriptor.mode).toBe("sharded");
    expect(storage.objects.get(`${result.bundleRootKey}_index/search/000001.jsonl`))
      .toContain("\"pages/guide-1.md\"");
    expect(storage.objects.get(`${result.bundleRootKey}_index/links/000001.jsonl`))
      .toContain("\"index.md\"");
    const manifestShardContent = manifestDescriptor.shards
      .map((shard) => storage.objects.get(`${result.bundleRootKey}${shard.path}`) ?? "")
      .join("\n");
    expect(manifestShardContent)
      .toContain("\"_index/search/000001.jsonl\"");
    expect(persistedFiles).toContainEqual(
      expect.objectContaining({
        logicalPath: "_index/search/000001.jsonl",
        fileKind: "search_index_shard"
      })
    );
    expect(persistedFiles).toContainEqual(
      expect.objectContaining({
        logicalPath: "_index/manifest/000001.jsonl",
        fileKind: "manifest_index_shard"
      })
    );
  });

  it("limits source file processing with the configured publication concurrency", async () => {
    const sources: SourceRecord[] = Array.from({ length: 4 }, (_value, index) =>
      sourceRecord(
        `source-${index}`,
        `source-${index}.md`,
        `tenant/demo/source/source-${index}.md`
      )
    );
    const storage = new PublicationStorage(sources);

    await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 4,
      concurrency: 2,
      storage,
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async () => undefined,
      persistBundleTreeEntries: async () => undefined
    });

    expect(storage.maxActiveReads).toBeGreaterThan(1);
    expect(storage.maxActiveReads).toBeLessThanOrEqual(2);
  });

  it("publishes source records with missing metadata by resolving generic fallback fields", async () => {
    const sources: SourceRecord[] = [
      {
        id: "source-001",
        originalName: "intro.md",
        objectKey: "tenant/demo/source/intro.md",
        metadata: {}
      }
    ];
    const storage = new PublicationStorage(sources);
    storage.objects.set("tenant/demo/source/intro.md", "# Missing metadata\n\nBody.");
    const persistedFiles: BundleFileDraft[] = [];

    await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 1,
      concurrency: 1,
      storage,
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async (files) => {
        persistedFiles.push(...files);
      },
      persistBundleTreeEntries: async () => undefined
    });

    expect(persistedFiles).toContainEqual(
      expect.objectContaining({
        logicalPath: "pages/intro.md",
        okfType: "document",
        title: "Missing metadata",
        frontmatter: {
          type: "document",
          title: "Missing metadata"
        }
      })
    );
  });

  it("does not publish model suggestion links without persisted graph edges", async () => {
    const sources: SourceRecord[] = [
      {
        ...sourceRecord("source-001", "intro.md", "tenant/demo/source/intro.md"),
        suggestions: {
          description: "",
          title: "",
          type: "",
          tags: [],
          related_links: [
            { title: "Setup", path: "pages/setup.md" },
            { title: "Deleted", path: "pages/deleted.md" }
          ],
          keywords: []
        }
      },
      sourceRecord("source-002", "setup.md", "tenant/demo/source/setup.md")
    ];
    const storage = new PublicationStorage(sources);

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 50,
      concurrency: 1,
      storage,
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async () => undefined,
      persistBundleTreeEntries: async () => undefined
    });

    const intro = storage.objects.get(`${result.bundleRootKey}pages/intro.md`) ?? "";
    const links = storage.objects.get(`${result.bundleRootKey}_index/links.json`) ?? "";

    expect(intro).not.toContain("[Setup](/pages/setup.md)");
    expect(intro).not.toContain("deleted.md");
    const linkIndex = JSON.parse(links) as {
      links: Array<{ from: string; to: string; label: string }>;
    };
    expect(linkIndex.links).not.toContainEqual(
      expect.objectContaining({ from: "pages/intro.md", to: "pages/setup.md" })
    );
    expect(links).toContain("\"from\": \"log.md\"");
    expect(links).not.toContain("pages/deleted.md");
  });

  it("publishes graph files, graph-backed related links, and graph references", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-intro", "intro.md", "tenant/demo/source/intro.md"),
      sourceRecord("source-setup", "setup.md", "tenant/demo/source/setup.md")
    ];
    const storage = new PublicationStorage(sources);
    const fileBatches: BundleFileDraft[][] = [];

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 2,
      concurrency: 1,
      storage,
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      fetchGraphNodePage: async () => ({
        items: [
          {
            fileId: "source-intro",
            path: "pages/intro.md",
            title: "intro",
            type: "page",
            tags: [],
            headings: ["intro"],
            keywords: ["intro"],
            metadata: { type: "page", title: "intro" }
          },
          {
            fileId: "source-setup",
            path: "pages/setup.md",
            title: "setup",
            type: "page",
            tags: [],
            headings: ["setup"],
            keywords: ["setup"],
            metadata: { type: "page", title: "setup" }
          }
        ],
        nextCursor: null
      }),
      fetchGraphEdgePage: async () => ({
        items: [
          {
            fromFileId: "source-intro",
            toFileId: "source-setup",
            relationType: "title_mention",
            weight: 0.7,
            reason: "Intro mentions setup.",
            source: "deterministic",
            evidence: { signal: "title_mention" }
          }
        ],
        nextCursor: null
      }),
      fetchGraphNeighborhood: async ({ sourceFileId }) => ({
        sourceFileId,
        relationships:
          sourceFileId === "source-intro"
            ? [
                {
                  fileId: "source-setup",
                  path: "pages/setup.md",
                  title: "setup",
                  relationType: "title_mention",
                  direction: "outgoing",
                  weight: 0.7,
                  reason: "Intro mentions setup.",
                  source: "deterministic",
                  evidence: { signal: "title_mention" }
                }
              ]
            : []
      }),
      persistBundleFiles: async (files) => {
        fileBatches.push(files);
      },
      persistBundleTreeEntries: async () => undefined
    });

    const intro = storage.objects.get(`${result.bundleRootKey}pages/intro.md`) ?? "";
    const manifest = storage.objects.get(`${result.bundleRootKey}_index/manifest.json`) ?? "";
    const search = storage.objects.get(`${result.bundleRootKey}_index/search.json`) ?? "";
    const byFile = storage.objects.get(
      `${result.bundleRootKey}_graph/by-file/source-intro.json`
    ) ?? "";

    expect(result.fileCount).toBe(14);
    expect(intro).toContain("fileId: \"source-intro\"");
    expect(intro).toContain("graph: \"../_graph/by-file/source-intro.json\"");
    expect(intro).toContain("- [setup](/pages/setup.md) - title_mention");
    expect(manifest).toContain("\"_graph/index.md\"");
    expect(manifest).toContain("\"_graph/by-file/source-intro.json\"");
    expect(search).toContain("\"fileId\": \"source-intro\"");
    expect(search).toContain("\"graphRef\": \"_graph/by-file/source-intro.json\"");
    expect(byFile).toContain("\"direction\": \"outgoing\"");
    expect(byFile).toContain("\"relationType\": \"title_mention\"");
    expect(fileBatches.flat()).toContainEqual(
      expect.objectContaining({
        logicalPath: "_graph/by-file/source-intro.json",
        sourceFileId: null,
        fileKind: "graph_file"
      })
    );
  });

  it("publishes graph node index through bounded shards when configured", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-intro", "intro.md", "tenant/demo/source/intro.md"),
      sourceRecord("source-setup", "setup.md", "tenant/demo/source/setup.md")
    ];
    const storage = new PublicationStorage(sources);

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 2,
      concurrency: 1,
      graph: {
        edgeShardSize: 1
      },
      storage,
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      fetchGraphNodePage: async () => ({
        items: [
          {
            fileId: "source-intro",
            path: "pages/intro.md",
            title: "intro",
            type: "page",
            tags: [],
            headings: ["intro"],
            keywords: ["intro"],
            metadata: { type: "page", title: "intro" }
          },
          {
            fileId: "source-setup",
            path: "pages/setup.md",
            title: "setup",
            type: "page",
            tags: [],
            headings: ["setup"],
            keywords: ["setup"],
            metadata: { type: "page", title: "setup" }
          }
        ],
        nextCursor: null
      }),
      fetchGraphEdgePage: async () => ({ items: [], nextCursor: null }),
      fetchGraphNeighborhood: async ({ sourceFileId }) => ({
        sourceFileId,
        relationships: []
      }),
      persistBundleFiles: async () => undefined,
      persistBundleTreeEntries: async () => undefined
    });

    const nodeRoot = storage.objects.get(`${result.bundleRootKey}_graph/nodes.jsonl`) ?? "";
    const firstShard = storage.objects.get(`${result.bundleRootKey}_graph/nodes/0000.jsonl`) ?? "";
    const secondShard = storage.objects.get(`${result.bundleRootKey}_graph/nodes/0001.jsonl`) ?? "";
    const manifest = storage.objects.get(`${result.bundleRootKey}_graph/manifest.json`) ?? "";

    expect(nodeRoot).toContain("\"type\":\"graph_node_shard\"");
    expect(nodeRoot).toContain("\"path\":\"_graph/nodes/0000.jsonl\"");
    expect(firstShard).toContain("\"fileId\":\"source-intro\"");
    expect(secondShard).toContain("\"fileId\":\"source-setup\"");
    expect(manifest).toContain("\"node_shard_count\": 2");
    expect(manifest).toContain("\"node_shard_pattern\": \"_graph/nodes/{shard}.jsonl\"");
  });

  it("publishes page related links from bounded graph neighborhoods without full graph loading", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-intro", "intro.md", "tenant/demo/source/intro.md"),
      sourceRecord("source-setup", "setup.md", "tenant/demo/source/setup.md")
    ];
    const storage = new PublicationStorage(sources);
    const neighborhoodCalls: Array<{ sourceFileId: string; limit: number }> = [];

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 2,
      concurrency: 1,
      storage,
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      fetchGraphNeighborhood: async ({ sourceFileId, limit }) => {
        neighborhoodCalls.push({ sourceFileId, limit });
        return {
          sourceFileId,
          relationships:
            sourceFileId === "source-intro"
              ? [
                  {
                    fileId: "source-setup",
                    path: "pages/setup.md",
                    title: "setup",
                    relationType: "title_mention",
                    direction: "outgoing",
                    weight: 0.7,
                    reason: "Intro mentions setup.",
                    source: "deterministic",
                    evidence: { signal: "title_mention" }
                  }
                ]
              : []
        };
      },
      persistBundleFiles: async () => undefined,
      persistBundleTreeEntries: async () => undefined
    });

    const intro = storage.objects.get(`${result.bundleRootKey}pages/intro.md`) ?? "";
    const manifest = storage.objects.get(`${result.bundleRootKey}_index/manifest.json`) ?? "";

    expect(neighborhoodCalls).toEqual([
      { sourceFileId: "source-intro", limit: 10 },
      { sourceFileId: "source-setup", limit: 10 }
    ]);
    expect(intro).toContain("- [setup](/pages/setup.md) - title_mention");
    expect(intro).not.toContain("graph:");
    expect(manifest).not.toContain("_graph/index.md");
  });

  it("publishes a bounded update log from current and historical publication summaries", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-001", "intro.md", "tenant/demo/source/intro.md")
    ];
    const storage = new PublicationStorage(sources);

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 50,
      concurrency: 1,
      log: {
        maxEntries: 2,
        maxBytes: 65_536
      },
      storage,
      fetchPublicationLogHistory: async () => ({
        entries: [
          {
            occurredAt: "2026-01-10T00:00:00.000Z",
            action: "Update",
            message: "Last quiet-period update.",
            changedFileCount: 7
          },
          {
            occurredAt: "2025-12-10T00:00:00.000Z",
            action: "Update",
            message: "Summarized older update.",
            changedFileCount: 3
          }
        ],
        summaries: [
          {
            month: "2025-11",
            publicationCount: 2,
            changedFileCount: 12
          }
        ]
      }),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async () => undefined,
      persistBundleTreeEntries: async () => undefined
    });
    const log = storage.objects.get(`${result.bundleRootKey}log.md`) ?? "";

    expect(log).toContain("## 2026-06-14");
    expect(log).toContain("Published 1 Markdown pages");
    expect(log).toContain("Added intro.");
    expect(log).not.toContain("Last quiet-period update.");
    expect(log).toContain("2026-01: 1 publication events, 7 documents changed.");
    expect(log).toContain("2025-12: 1 publication events, 3 documents changed.");
    expect(log).toContain("2025-11: 2 publication events, 12 documents changed.");
  });
});
