import { describe, expect, it } from "vitest";
import { publishOkfRelease, type BundleFileDraft } from "../src/okf/publication.js";
import type {
  ReleaseMarkdownLinkRecord,
  ReleaseNavigationEntryRecord
} from "../src/application/ports/release-publication-repository.js";
import { createStorageKeyspace, type StorageKeyspace } from "../src/storage/keys.js";
import type { StoredObject } from "../src/storage/s3.js";
import {
  validateOkfBundleProfile,
  type SourceMetadataDefaults
} from "@focowiki/okf";

type SourceRecord = {
  id: string;
  name: string;
  relativePath: string;
  generatedPath: string;
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

function sourceRecord(id: string, relativePath: string, objectKey: string): SourceRecord {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return {
    id,
    name,
    relativePath,
    generatedPath: `pages/${relativePath}`,
    objectKey,
    metadata: {
      type: "page",
      title: name.replace(/\.md$/, "")
    }
  };
}

function publicationReadModelFixture(sources: SourceRecord[]) {
  const entries = navigationEntries(sources);
  const links: ReleaseMarkdownLinkRecord[] = [];
  const sourcePaths = new Set(sources.map((source) => source.generatedPath));
  const generatedPaths = new Set([
    "index.md",
    "log.md",
    "schema.md",
    "schema-frontmatter.md",
    "schema-navigation.md",
    "schema-extensions.md",
    "_index/index.md",
    "_index/manifest.json",
    "_index/search.json",
    "_index/links.json",
    "_index/changes.json",
    "pages/index.md",
    ...entries
      .filter((entry) => entry.kind === "directory_start")
      .map((entry) => `${entry.parentPath}/index.md`)
  ]);
  return {
    sourceFileCount: sources.length,
    fetchNavigationEntryPage: async ({ cursor, limit }: { cursor: string | null; limit: number }) => {
      const start = cursor ? Number(cursor) : 0;
      const items = entries.slice(start, start + limit);
      return {
        items,
        nextCursor: start + limit < entries.length ? String(start + limit) : null
      };
    },
    persistMarkdownLinks: async (records: ReleaseMarkdownLinkRecord[]) => {
      links.push(...records);
    },
    copyReusableMarkdownLinks: async () => undefined,
    pruneInvalidSourceMarkdownLinks: async () => 0,
    fetchMarkdownLinkPage: async ({ cursor, limit, plannedTargetPaths }: {
      cursor: string | null;
      limit: number;
      plannedTargetPaths: string[];
    }) => {
      const allowedPlannedPaths = new Set(plannedTargetPaths);
      const ordered = links
        .filter((link) =>
          sourcePaths.has(link.to)
          || generatedPaths.has(link.to)
          || allowedPlannedPaths.has(link.to)
          || link.to.startsWith("_graph/")
        )
        .sort((left, right) =>
          `${left.from}\u0000${left.to}\u0000${left.label}`.localeCompare(
            `${right.from}\u0000${right.to}\u0000${right.label}`
          )
        );
      const start = cursor ? Number(cursor) : 0;
      return {
        items: ordered.slice(start, start + limit).map(({ from, to, label }) => ({
          from,
          to,
          label
        })),
        nextCursor: start + limit < ordered.length ? String(start + limit) : null
      };
    },
    materializeBundleTree: async () => ({ entryCount: 0 })
  };
}

function navigationEntries(sources: SourceRecord[]): ReleaseNavigationEntryRecord[] {
  const directEntries = new Map<string, ReleaseNavigationEntryRecord[]>();
  const ensure = (path: string) => {
    const current = directEntries.get(path) ?? [];
    directEntries.set(path, current);
    return current;
  };
  ensure("pages");
  for (const source of sources) {
    const segments = source.generatedPath.split("/");
    const fileName = segments.at(-1) ?? source.relativePath;
    const parentPath = segments.slice(0, -1).join("/");
    ensure(parentPath).push({
      id: `file:${source.id}`,
      parentPath,
      kind: "file",
      name: fileName,
      targetPath: fileName,
      label: fileName.replace(/\.md$/i, ""),
      entryCount: null,
      directChildCount: null,
      title: typeof source.metadata.title === "string" ? source.metadata.title : null,
      description: source.suggestions?.description ?? source.metadata.description ?? null,
      timestamp: typeof source.metadata.timestamp === "string" ? source.metadata.timestamp : null,
      version: typeof source.metadata.version === "string" ? source.metadata.version : null,
      duplicateTitleCount: 1
    });
    for (let index = 1; index < segments.length - 1; index += 1) {
      const directoryPath = segments.slice(0, index + 1).join("/");
      const ownerPath = segments.slice(0, index).join("/");
      const name = segments[index] ?? "";
      ensure(directoryPath);
      const owner = ensure(ownerPath);
      if (!owner.some((entry) => entry.kind === "directory" && entry.name === name)) {
        owner.push({
          id: `directory:${directoryPath}`,
          parentPath: ownerPath,
          kind: "directory",
          name,
          targetPath: `${name}/index.md`,
          label: name,
          entryCount: null,
          directChildCount: 0,
          title: null,
          description: null,
          timestamp: null,
          version: null,
          duplicateTitleCount: 1
        });
      }
    }
  }
  return [...directEntries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([parentPath, children]) => [
      {
        id: `start:${parentPath}`,
        parentPath,
        kind: "directory_start" as const,
        name: "",
        targetPath: "",
        label: "",
        entryCount: children.length,
        directChildCount: null,
        title: null,
        description: null,
        timestamp: null,
        version: null,
        duplicateTitleCount: 1
      },
      ...children.sort((left, right) =>
        `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
      )
    ]);
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
        `---\ntype: page\ntitle: ${source.relativePath.replace(/\.md$/, "")}\n---\n# ${source.relativePath}`
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

  public async copyObject(input: { sourceKey: string; destinationKey: string }): Promise<void> {
    const content = this.objects.get(input.sourceKey);
    if (content === undefined) {
      throw new Error(`Missing copy source: ${input.sourceKey}`);
    }
    this.objects.set(input.destinationKey, content);
  }
}

describe("publishOkfRelease", () => {
  it("generates the official minimal-example roles with generic source concepts", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-sales", "datasets/sales.md", "tenant/demo/source/sales.md"),
      sourceRecord("source-orders", "tables/orders.md", "tenant/demo/source/orders.md"),
      sourceRecord("source-customers", "tables/customers.md", "tenant/demo/source/customers.md")
    ];
    sources[0]!.metadata = {
      type: "Dataset",
      title: "Sales",
      description: "Groups the retail sales concepts used by this example."
    };
    sources[1]!.metadata = {
      type: "Table",
      title: "Orders",
      description: "Describes completed customer orders."
    };
    sources[2]!.metadata = {
      type: "Table",
      title: "Customers",
      description: "Describes customers referenced by orders."
    };
    const storage = new PublicationStorage(sources);
    storage.objects.set(
      sources[0]!.objectKey,
      "---\ntype: Dataset\ntitle: Sales\ndescription: Groups the retail sales concepts used by this example.\n---\n# Sales\n\nSee [Orders](/pages/tables/orders.md) and [Customers](/pages/tables/customers.md)."
    );
    storage.objects.set(
      sources[1]!.objectKey,
      "---\ntype: Table\ntitle: Orders\ndescription: Describes completed customer orders.\n---\n# Orders\n\nEach order belongs to a [Customer](/pages/tables/customers.md)."
    );
    storage.objects.set(
      sources[2]!.objectKey,
      "---\ntype: Table\ntitle: Customers\ndescription: Describes customers referenced by orders.\n---\n# Customers"
    );

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-minimal",
      knowledgeBaseName: "Retail knowledge",
      knowledgeBaseDescription: "Generic concepts for the official minimal-example comparison.",
      releaseId: "release-minimal",
      generatedAt: "2026-07-13T00:00:00.000Z",
      pageSize: 2,
      concurrency: 1,
      storage,
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async ({ cursor, limit }) => {
        const start = cursor ? Number(cursor) : 0;
        return {
          items: sources.slice(start, start + limit),
          nextCursor: start + limit < sources.length ? String(start + limit) : null
        };
      },
      persistBundleFiles: async () => undefined
    });

    const releaseFiles = [...storage.objects.entries()]
      .filter(([key]) => key.startsWith(result.bundleRootKey))
      .map(([key, content]) => ({
        path: key.slice(result.bundleRootKey.length),
        content
      }));
    const markdownFiles = releaseFiles.filter((file) => file.path.endsWith(".md"));
    const pagesIndex = markdownFiles.find((file) => file.path === "pages/index.md")?.content ?? "";
    const datasetsIndex = markdownFiles.find(
      (file) => file.path === "pages/datasets/index.md"
    )?.content ?? "";
    const tablesIndex = markdownFiles.find(
      (file) => file.path === "pages/tables/index.md"
    )?.content ?? "";

    expect(() => validateOkfBundleProfile(releaseFiles, "focowiki_quality")).not.toThrow();
    expect(markdownFiles.map((file) => file.path)).toEqual(expect.arrayContaining([
      "index.md",
      "log.md",
      "pages/index.md",
      "pages/datasets/index.md",
      "pages/datasets/sales.md",
      "pages/tables/index.md",
      "pages/tables/orders.md",
      "pages/tables/customers.md"
    ]));
    expect(pagesIndex).toContain("[datasets](/pages/datasets/index.md)");
    expect(pagesIndex).toContain("[tables](/pages/tables/index.md)");
    expect(datasetsIndex.match(/\(\/pages\/datasets\/sales\.md\)/gu)).toHaveLength(1);
    expect(tablesIndex.match(/\(\/pages\/tables\/orders\.md\)/gu)).toHaveLength(1);
    expect(tablesIndex.match(/\(\/pages\/tables\/customers\.md\)/gu)).toHaveLength(1);
    expect(markdownFiles.find((file) => file.path === "pages/datasets/sales.md")?.content)
      .toContain("[Orders](/pages/tables/orders.md)");
  });

  it("reads source records through cursor pages and publishes bounded release records", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-001", "intro.md", "tenant/demo/source/intro.md"),
      sourceRecord("source-002", "setup.md", "tenant/demo/source/setup.md")
    ];
    sources[0]!.metadata = {
      type: "page",
      title: "Intro",
      description: "Intro"
    };
    sources[0]!.suggestions = {
      title: "Intro",
      type: "page",
      description: "Introduction to the developer documentation.",
      tags: [],
      related_links: [],
      keywords: []
    };
    const fetchCalls: Array<{ cursor: string | null; limit: number }> = [];
    const fileBatches: BundleFileDraft[][] = [];
    const storage = new PublicationStorage(sources);

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      knowledgeBaseDescription: "Internal product and API documentation.",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 1,
      concurrency: 1,
      storage,
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async ({ cursor, limit }) => {
        fetchCalls.push({ cursor, limit });
        const start = cursor ? Number(cursor) : 0;
        const items = sources.slice(start, start + limit);
        const nextCursor = start + limit < sources.length ? String(start + limit) : null;
        return { items, nextCursor };
      },
      persistBundleFiles: async (files) => {
        fileBatches.push(files);
      }
    });

    expect(fetchCalls).toEqual([
      { cursor: null, limit: 1 },
      { cursor: "1", limit: 1 }
    ]);
    expect(storage.maxActiveReads).toBeLessThanOrEqual(1);
    expect(result.fileCount).toBe(14);
    expect(result.bundleRootKey).toBe("tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/");
    const rootIndex = storage.objects.get(`${result.bundleRootKey}index.md`) ?? "";
    const pagesIndex = storage.objects.get(`${result.bundleRootKey}pages/index.md`) ?? "";
    const machineIndex = storage.objects.get(`${result.bundleRootKey}_index/index.md`) ?? "";
    const schemaFile = storage.objects.get(`${result.bundleRootKey}schema.md`) ?? "";
    const introPage = storage.objects.get(`${result.bundleRootKey}pages/intro.md`) ?? "";
    const manifest = storage.objects.get(`${result.bundleRootKey}_index/manifest.json`) ?? "";
    const search = storage.objects.get(`${result.bundleRootKey}_index/search.json`) ?? "";
    expect(rootIndex).toContain('okf_version: "0.1"');
    expect(rootIndex).toContain("# Developer docs");
    expect(rootIndex).toContain("Internal product and API documentation.");
    expect(rootIndex).toContain(
      "[Browse documents](/pages/index.md) - Explore source-backed Markdown files by directory."
    );
    expect(rootIndex).toContain(
      "[Developer docs schema](/schema.md) - Review concept metadata and navigation conventions."
    );
    expect(rootIndex).not.toContain("_graph/index.md");
    expect(pagesIndex).toContain(
      "[Intro](/pages/intro.md) - Introduction to the developer documentation."
    );
    expect(introPage).toContain(
      'description: "Introduction to the developer documentation."'
    );
    expect(manifest).toContain(
      '"description": "Introduction to the developer documentation."'
    );
    expect(search).toContain(
      '"description": "Introduction to the developer documentation."'
    );
    expect(machineIndex).toContain(
      "[Search index](/_index/search.json) - Discover source-backed concepts through generated search records."
    );
    expect(machineIndex).toContain(
      "[Browse documents](/pages/index.md) - Continue to source-backed Markdown evidence."
    );
    expect(schemaFile).toContain(
      "[Browse documents](/pages/index.md) - Continue to source-backed Markdown evidence."
    );
    expect(schemaFile).not.toContain("fileId");
    expect(schemaFile).not.toContain("by-file");
    expect(storage.objects.get(`${result.bundleRootKey}log.md`)).toContain("# Directory Update Log");
    expect(storage.objects.get(`${result.bundleRootKey}log.md`)).toContain("Published 2 Markdown pages");
    expect(storage.objects.get(`${result.bundleRootKey}log.md`)).toContain("[Intro](/pages/intro.md)");
    expect(storage.objects.get(`${result.bundleRootKey}_index/manifest.json`)).toContain(
      "\"pages/intro.md\""
    );
    expect(storage.objects.get(`${result.bundleRootKey}_index/manifest.json`)).toContain(
      "\"log.md\""
    );
    expect(
      [...storage.objects.entries()]
        .filter(([key]) => key.startsWith(result.bundleRootKey) && key.endsWith(".md"))
        .every(([, content]) => content.endsWith("\n") && !content.endsWith("\n\n"))
    ).toBe(true);
    expect(storage.objects.get(`${result.bundleRootKey}_index/manifest.json`)).toContain(
      "\"Developer docs schema\""
    );
    expect(fileBatches.every((batch) => batch.length <= 1)).toBe(true);
    expect(fileBatches.flat().map((file) => file.logicalPath).sort()).toEqual([
      "_index/changes.json",
      "_index/index.md",
      "_index/links.json",
      "_index/manifest.json",
      "_index/search.json",
      "index.md",
      "log.md",
      "pages/index.md",
      "pages/intro.md",
      "pages/setup.md",
      "schema-extensions.md",
      "schema-frontmatter.md",
      "schema-navigation.md",
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
    expect(fileBatches.flat()).toContainEqual(
      expect.objectContaining({
        logicalPath: "schema-frontmatter.md",
        fileKind: "schema",
        okfType: "Schema Reference",
        title: "Frontmatter",
        description: "Concept frontmatter requirements and recommendations.",
        frontmatter: {
          type: "Schema Reference",
          title: "Frontmatter",
          description: "Concept frontmatter requirements and recommendations."
        }
      })
    );
  });

  it("publishes equal basenames from distinct source directories", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-001", "department-a/guide.md", "tenant/demo/source/guide-1.md"),
      sourceRecord("source-002", "department-b/guide.md", "tenant/demo/source/guide-2.md")
    ];
    const fileBatches: BundleFileDraft[][] = [];
    const storage = new PublicationStorage(sources);

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 10,
      concurrency: 1,
      storage,
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async (files) => {
        fileBatches.push(files);
      }
    });

    const logicalPaths = fileBatches.flat().map((file) => file.logicalPath).sort();
    expect(result.fileCount).toBe(16);
    expect(logicalPaths).toContain("pages/department-a/guide.md");
    expect(logicalPaths).toContain("pages/department-b/guide.md");
    expect(storage.objects.get(`${result.bundleRootKey}pages/department-a/index.md`)).toContain(
      "[guide](/pages/department-a/guide.md)"
    );
    expect(storage.objects.get(`${result.bundleRootKey}pages/department-b/index.md`)).toContain(
      "[guide](/pages/department-b/guide.md)"
    );
  });

  it("copies unchanged pages into release-owned objects", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-001", "intro.md", "tenant/demo/source/intro.md"),
      sourceRecord("source-002", "setup.md", "tenant/demo/source/setup.md")
    ];
    const storage = new PublicationStorage(sources);
    const persistedFiles: BundleFileDraft[] = [];
    storage.objects.set(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
      "---\ntype: page\ntitle: Intro\n---\n# Intro"
    );

    await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-002",
      generatedAt: "2026-06-14T00:10:00.000Z",
      pageSize: 10,
      concurrency: 1,
      storage,
      ...publicationReadModelFixture(sources),
      dirtySourceFileIds: ["source-002"],
      fetchReusablePages: async () => [
          {
            sourceFileId: "source-001",
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
      fetchSourceGraphNeighborhood: async ({ sourceFileId }) => ({
        sourceFileId,
        relationships: sourceFileId === "source-001"
          ? [{
              fileId: "source-002",
              path: "pages/setup.md",
              title: "setup",
              relationType: "same_specific_subject",
              direction: "outgoing",
              weight: 0.72,
              reason: "Intro and setup share a subject.",
              source: "deterministic",
              evidence: { signal: "same_specific_subject" }
            }]
          : []
      }),
      fetchGraphEdgePage: async () => ({
        items: [
          {
            fromFileId: "source-001",
            toFileId: "source-002",
            relationType: "same_specific_subject",
            weight: 0.72,
            reason: "Intro and setup share a subject.",
            source: "deterministic",
            evidence: { signal: "same_specific_subject" }
          }
        ],
        nextCursor: null
      }),
      fetchGraphNodePage: async () => ({
        items: sources.map((source) => ({
          fileId: source.id,
          path: `pages/${source.relativePath}`,
          title: source.relativePath.replace(/\.md$/u, ""),
          type: "page",
          tags: [],
          headings: [],
          keywords: [],
          metadata: { type: "page", title: source.relativePath.replace(/\.md$/u, "") }
        })),
        nextCursor: null
      }),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async (files) => {
        persistedFiles.push(...files);
      }
    });

    expect(storage.readKeys).toEqual(["tenant/demo/source/setup.md"]);
    expect(persistedFiles).toContainEqual(
      expect.objectContaining({
        sourceFileId: "source-001",
        logicalPath: "pages/intro.md",
        objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-002/bundle/pages/intro.md",
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
    expect(links.links).not.toContainEqual(
      expect.objectContaining({ from: "pages/intro.md", to: "pages/setup.md" })
    );
    const search = storage.objects.get(
      "tenant/demo/knowledge-bases/kb-001/releases/release-002/bundle/_index/search.json"
    ) ?? "";
    expect(search).toContain('"graphRef": "_graph/by-file/source-001.json"');
  });

  it("keeps original Markdown file names in public bundle paths", async () => {
    const sourceName = "客户支持手册.md";
    const sources: SourceRecord[] = [
      sourceRecord("source-001", sourceName, "tenant/demo/source/original.md")
    ];
    const fileBatches: BundleFileDraft[][] = [];
    const storage = new PublicationStorage(sources);

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 50,
      concurrency: 1,
      storage,
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async (files) => {
        fileBatches.push(files);
      }
    });

    const pagePath = `pages/${sourceName}`;
    expect(fileBatches.flat().map((file) => file.logicalPath)).toEqual(
      expect.arrayContaining([pagePath])
    );
    expect(fileBatches.flat().map((file) => file.logicalPath)).not.toContain(
      `sources/${sourceName}`
    );
    expect(storage.objects.get(`${result.bundleRootKey}pages/index.md`)).toContain(
      `[客户支持手册](/pages/${encodeURIComponent(sourceName)})`
    );
    expect(storage.objects.get(`${result.bundleRootKey}index.md`)).toContain("# Developer docs");
    expect(storage.objects.get(`${result.bundleRootKey}_index/manifest.json`)).toContain(
      `"${pagePath}"`
    );
  });

  it("publishes generic and pass-through frontmatter metadata into JSON indexes", async () => {
    const sources: SourceRecord[] = [
      {
        id: "source-001",
        name: "support-guide.md",
        relativePath: "support-guide.md",
        generatedPath: "pages/support-guide.md",
        objectKey: "tenant/demo/source/support-guide.md",
        metadata: {
          type: "guide",
          title: "Support guide",
          description: "Factual rule description",
          resource: "https://example.com/support-guide",
          timestamp: "2026-06-14T00:00:00.000Z",
          tags: ["support", "rule"],
          externalId: "doc-001",
          status: "active",
          department: "example",
          objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/support-guide.md",
          releaseId: "release-001",
          localPath: "/private/tmp/support-guide.md",
          providerPayload: {
            id: "provider-output"
          }
        }
      }
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
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async () => undefined
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

    const manifestPage = manifest.files.find((file) => file.path === "pages/support-guide.md");
    expect(manifestPage?.metadata).toMatchObject({
      type: "guide",
      title: "Support guide",
      description: "Factual rule description",
      resource: "https://example.com/support-guide",
      timestamp: "2026-06-14T00:00:00.000Z",
      tags: ["support", "rule"],
      externalId: "doc-001",
      status: "active",
      department: "example"
    });
    expect(manifestPage?.metadata).not.toHaveProperty("objectKey");
    expect(manifestPage?.metadata).not.toHaveProperty("releaseId");
    expect(manifestPage?.metadata).not.toHaveProperty("taskId");
    expect(manifestPage?.metadata).not.toHaveProperty("localPath");
    expect(manifestPage?.metadata).not.toHaveProperty("providerPayload");

    expect(search.items).toContainEqual(
      expect.objectContaining({
        path: "pages/support-guide.md",
        type: "guide",
        title: "Support guide",
        description: "Factual rule description",
        resource: "https://example.com/support-guide",
        timestamp: "2026-06-14T00:00:00.000Z",
        tags: ["support", "rule"],
        metadata: expect.objectContaining({
          externalId: "doc-001",
          status: "active",
          department: "example"
        })
      })
    );
    const searchPage = search.items.find((item) => item.path === "pages/support-guide.md");
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
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async (files) => {
        persistedFiles.push(...files);
      }
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
      .toContain("\"from\"");
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
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async () => undefined
    });

    expect(storage.maxActiveReads).toBeGreaterThan(1);
    expect(storage.maxActiveReads).toBeLessThanOrEqual(2);
  });

  it("publishes source records with missing metadata by resolving generic fallback fields", async () => {
    const sources: SourceRecord[] = [
      {
        id: "source-001",
        name: "intro.md",
        relativePath: "intro.md",
        generatedPath: "pages/intro.md",
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
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async (files) => {
        persistedFiles.push(...files);
      }
    });

    expect(persistedFiles).toContainEqual(
      expect.objectContaining({
        logicalPath: "pages/intro.md",
        okfType: "document",
        title: "Missing metadata",
        description: "Body.",
        frontmatter: {
          type: "document",
          title: "Missing metadata",
          description: "Body."
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
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      persistBundleFiles: async () => undefined
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
      ...publicationReadModelFixture(sources),
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
            relationType: "direct_reference",
            weight: 0.7,
            reason: "Intro mentions setup.",
            source: "deterministic",
            evidence: { signal: "direct_reference" }
          }
        ],
        nextCursor: null
      }),
      fetchSourceGraphNeighborhood: async ({ sourceFileId }) => ({
        sourceFileId,
        relationships:
          sourceFileId === "source-intro"
            ? [
                {
                  fileId: "source-setup",
                  path: "pages/setup.md",
                  title: "setup",
                  relationType: "direct_reference",
                  direction: "outgoing",
                  weight: 0.7,
                  reason: "Intro mentions setup.",
                  source: "deterministic",
                  evidence: { signal: "direct_reference" }
                }
              ]
            : []
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
                  relationType: "direct_reference",
                  direction: "outgoing",
                  weight: 0.7,
                  reason: "Intro mentions setup.",
                  source: "deterministic",
                  evidence: { signal: "direct_reference" }
                }
              ]
            : []
      }),
      persistBundleFiles: async (files) => {
        fileBatches.push(files);
      }
    });

    const intro = storage.objects.get(`${result.bundleRootKey}pages/intro.md`) ?? "";
    const manifest = storage.objects.get(`${result.bundleRootKey}_index/manifest.json`) ?? "";
    const search = storage.objects.get(`${result.bundleRootKey}_index/search.json`) ?? "";
    const byFile = storage.objects.get(
      `${result.bundleRootKey}_graph/by-file/source-intro.json`
    ) ?? "";
    const graphIndex = storage.objects.get(`${result.bundleRootKey}_graph/index.md`) ?? "";
    const rootIndex = storage.objects.get(`${result.bundleRootKey}index.md`) ?? "";
    const graphManifest = storage.objects.get(`${result.bundleRootKey}_graph/manifest.json`) ?? "";
    const communities = storage.objects.get(`${result.bundleRootKey}_graph/communities.json`) ?? "";
    const insights = storage.objects.get(`${result.bundleRootKey}_graph/insights.json`) ?? "";

    expect(result.fileCount).toBe(22);
    expect(intro).not.toContain("fileId:");
    expect(intro).not.toContain("source-intro");
    expect(intro).not.toContain("_graph/by-file/");
    expect(intro).toContain("- [setup](/pages/setup.md) - Intro mentions setup.");
    expect(intro).not.toContain("direct_reference");
    expect(manifest).toContain("\"_graph/index.md\"");
    expect(manifest).toContain("\"_graph/by-file/source-intro.json\"");
    expect(search).toContain("\"fileId\": \"source-intro\"");
    expect(search).toContain("\"graphRef\": \"_graph/by-file/source-intro.json\"");
    expect(search).not.toContain("\"path\": \"index.md\"");
    expect(search).not.toContain("\"path\": \"pages/index.md\"");
    expect(search).not.toContain("index-000001.md");
    expect(byFile).toContain("\"direction\": \"outgoing\"");
    expect(byFile).toContain("\"relationType\": \"direct_reference\"");
    expect(rootIndex).toContain(
      "[Relationship graph](/_graph/index.md) - Follow relationships between source-backed files."
    );
    expect(graphIndex).toContain(
      "[Communities](/_graph/communities.json) - Browse bounded groups of related source-backed files."
    );
    expect(graphIndex).toContain(
      "[Insights](/_graph/insights.json) - Read bounded generated observations about the file graph."
    );
    expect(graphIndex).toContain(
      "[Edge shards](/_graph/edges/0000.jsonl) - Follow accepted relationships between source-backed Markdown files."
    );
    expect(graphIndex).not.toContain("fileId");
    expect(graphIndex).not.toContain("by-file");
    expect(graphManifest).toContain("\"communities_path\": \"_graph/communities.json\"");
    expect(graphManifest).toContain("\"insights_path\": \"_graph/insights.json\"");
    expect(graphManifest).not.toContain("pages/index.md");
    expect(graphManifest).not.toContain("index-000001.md");
    expect(communities).toContain("\"communities\": []");
    expect(insights).toContain("\"insights\": []");
    expect(fileBatches.flat()).toContainEqual(
      expect.objectContaining({
        logicalPath: "_graph/by-file/source-intro.json",
        sourceFileId: null,
        fileKind: "graph_file"
      })
    );
    expect(fileBatches.flat()).toContainEqual(
      expect.objectContaining({
        logicalPath: "_graph/communities.json",
        sourceFileId: null,
        fileKind: "graph_community"
      })
    );
    expect(fileBatches.flat()).toContainEqual(
      expect.objectContaining({
        logicalPath: "_graph/insights.json",
        sourceFileId: null,
        fileKind: "graph_insight"
      })
    );
  });

  it("writes graph frontmatter relative to nested publication paths", async () => {
    const sources = [
      sourceRecord(
        "source-nested",
        "部门/项目/文档.md",
        "tenant/demo/source/nested.md"
      )
    ];
    const storage = new PublicationStorage(sources);
    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-nested-graph",
      knowledgeBaseName: "Nested graph",
      releaseId: "release-nested-graph",
      generatedAt: "2026-01-01T00:00:00.000Z",
      pageSize: 10,
      concurrency: 1,
      storage,
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      fetchGraphNodePage: async () => ({
        items: [
          {
            fileId: "source-nested",
            path: "pages/部门/项目/文档.md",
            title: "Nested",
            type: "guide",
            tags: [],
            headings: ["Nested"],
            keywords: ["Nested"],
            metadata: { type: "guide", title: "Nested" }
          }
        ],
        nextCursor: null
      }),
      fetchGraphEdgePage: async () => ({ items: [], nextCursor: null }),
      fetchSourceGraphNeighborhood: async () => ({
        sourceFileId: "source-nested",
        relationships: []
      }),
      persistBundleFiles: async () => undefined
    });
    const nested = storage.objects.get(`${result.bundleRootKey}pages/部门/项目/文档.md`) ?? "";

    expect(nested).not.toContain("fileId:");
    expect(nested).not.toContain("source-nested");
    expect(nested).not.toContain("_graph/by-file/");
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
      ...publicationReadModelFixture(sources),
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
      persistBundleFiles: async () => undefined
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

  it("publishes graph edge shards with deterministic large-graph boundaries", async () => {
    const sources: SourceRecord[] = [
      sourceRecord("source-a", "a.md", "tenant/demo/source/a.md"),
      sourceRecord("source-b", "b.md", "tenant/demo/source/b.md"),
      sourceRecord("source-c", "c.md", "tenant/demo/source/c.md")
    ];
    const storage = new PublicationStorage(sources);
    const persistedFiles: BundleFileDraft[] = [];

    const result = await publishOkfRelease({
      knowledgeBaseId: "kb-001",
      knowledgeBaseName: "Developer docs",
      releaseId: "release-001",
      generatedAt: "2026-06-14T00:00:00.000Z",
      pageSize: 2,
      concurrency: 1,
      graph: {
        edgeShardSize: 2
      },
      storage,
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      fetchGraphNodePage: async () => ({
        items: sources.map((source) => ({
          fileId: source.id,
          path: `pages/${source.relativePath}`,
          title: source.metadata.title ?? source.relativePath,
          type: "page",
          tags: [],
          headings: [source.relativePath],
          keywords: [source.relativePath],
          metadata: { type: "page", title: source.relativePath }
        })),
        nextCursor: null
      }),
      fetchGraphEdgePage: async () => ({
        items: [
          {
            fromFileId: "source-a",
            toFileId: "source-b",
            relationType: "same_specific_subject",
            weight: 0.8,
            reason: "A and B share a specific subject.",
            source: "deterministic",
            evidence: { signal: "same_specific_subject" }
          },
          {
            fromFileId: "source-b",
            toFileId: "source-c",
            relationType: "process_adjacent",
            weight: 0.7,
            reason: "B and C describe adjacent steps.",
            source: "deterministic",
            evidence: { signal: "process_adjacent" }
          },
          {
            fromFileId: "source-c",
            toFileId: "source-a",
            relationType: "background",
            weight: 0.6,
            reason: "C provides background for A.",
            source: "deterministic",
            evidence: { signal: "background" }
          }
        ],
        nextCursor: null
      }),
      fetchGraphNeighborhood: async ({ sourceFileId }) => ({
        sourceFileId,
        relationships: []
      }),
      persistBundleFiles: async (files) => {
        persistedFiles.push(...files);
      }
    });

    const firstEdgeShard = storage.objects.get(`${result.bundleRootKey}_graph/edges/0000.jsonl`) ?? "";
    const secondEdgeShard = storage.objects.get(`${result.bundleRootKey}_graph/edges/0001.jsonl`) ?? "";
    const manifest = storage.objects.get(`${result.bundleRootKey}_graph/manifest.json`) ?? "";

    expect(firstEdgeShard.trim().split("\n")).toHaveLength(2);
    expect(secondEdgeShard.trim().split("\n")).toHaveLength(1);
    expect(firstEdgeShard).toContain("\"relationType\":\"same_specific_subject\"");
    expect(firstEdgeShard).toContain("\"relationType\":\"process_adjacent\"");
    expect(secondEdgeShard).toContain("\"relationType\":\"background\"");
    expect(manifest).toContain("\"edge_shard_count\": 2");
    expect(manifest).toContain("\"edge_shard_pattern\": \"_graph/edges/{shard}.jsonl\"");
    expect(persistedFiles).toContainEqual(
      expect.objectContaining({
        logicalPath: "_graph/edges/0000.jsonl",
        fileKind: "graph_edge_shard"
      })
    );
    expect(persistedFiles).toContainEqual(
      expect.objectContaining({
        logicalPath: "_graph/edges/0001.jsonl",
        fileKind: "graph_edge_shard"
      })
    );
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
      ...publicationReadModelFixture(sources),
      fetchSourcePage: async () => ({ items: sources, nextCursor: null }),
      fetchSourceGraphNeighborhood: async ({ sourceFileId, limit }) => {
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
                    relationType: "direct_reference",
                    direction: "outgoing",
                    weight: 0.7,
                    reason: "Intro mentions setup.",
                    source: "deterministic",
                    evidence: { signal: "direct_reference" }
                  },
                  {
                    fileId: "source-setup",
                    path: "pages/setup.md",
                    title: "setup",
                    relationType: "direct_reference",
                    direction: "incoming",
                    weight: 0.7,
                    reason: "Setup mentions intro.",
                    source: "deterministic",
                    evidence: { signal: "direct_reference" }
                  }
                ]
              : []
        };
      },
      persistBundleFiles: async () => undefined
    });

    const intro = storage.objects.get(`${result.bundleRootKey}pages/intro.md`) ?? "";
    const manifest = storage.objects.get(`${result.bundleRootKey}_index/manifest.json`) ?? "";

    expect(neighborhoodCalls).toEqual([
      { sourceFileId: "source-intro", limit: 10 },
      { sourceFileId: "source-setup", limit: 10 }
    ]);
    expect(intro.match(/^- \[setup\]\(\/pages\/setup\.md\) - Intro mentions setup\.$/gm))
      .toHaveLength(1);
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
      releaseChangeSummary: {
        created: 0,
        updated: 0,
        moved: 0,
        deleted: 1,
        affectedDirectories: [
          {
            path: "pages/removed",
            changedFileCount: 1
          }
        ]
      },
      storage,
      ...publicationReadModelFixture(sources),
      fetchPublicationLogHistory: async () => ({
        entries: [
          {
            occurredAt: "2026-01-10T00:00:00.000Z",
            action: "Update",
            message: "Last quiet-period update.",
            changedFileCount: 7,
            links: [
              {
                path: "pages/removed.md",
                title: "Removed page"
              }
            ]
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
      persistBundleFiles: async () => undefined
    });
    const log = storage.objects.get(`${result.bundleRootKey}log.md`) ?? "";
    const logPage = storage.objects.get(`${result.bundleRootKey}log-000001.md`) ?? "";

    expect(log).toContain("## 2026-06-14");
    expect(log).toContain("Published 1 Markdown pages");
    expect(log).not.toContain("pages/removed/index.md");
    expect(log).not.toContain("Last quiet-period update.");
    expect(log).not.toContain("Summarized older update.");
    expect(log).toContain("2026-01 contains 1 publication events and 7 changed files.");
    expect(log).toContain("2025-12 contains 1 publication events and 3 changed files.");
    expect(log).toContain("2025-11 contains 2 publication events and 12 changed files.");
    expect(log).toContain("[Update history page 1](/log-000001.md)");
    expect(log).not.toContain("### Older Updates");
    expect(log).not.toContain("### Detailed History");
    expect(logPage).toContain('type: "Update History Page"');
    expect(logPage).toContain("navigation_only: true");
    expect(logPage).toContain("Last quiet-period update.");
    expect(logPage).toContain("Summarized older update.");
    expect(logPage).not.toContain("[Removed page](pages/removed.md)");
    expect(logPage).toContain("[Update history root](/log.md)");
  });
});
