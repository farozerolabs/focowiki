import { describe, expect, it } from "vitest";
import type {
  AdminRepositories,
  BundleFileRecord,
  KnowledgeBaseRecord
} from "../src/db/admin-repositories.js";
import { backfillGeneratedFileSearchDocuments } from "../src/search/generated-file-search-backfill.js";
import type { GeneratedFileSearchDocumentDraft } from "../src/search/generated-file-search-documents.js";
import type { RuntimeLogger } from "../src/logger.js";

const now = "2026-06-17T00:00:00.000Z";

describe("generated file search document indexing", () => {
  it("indexes active releases in bounded pages and can rerun safely", async () => {
    const written: GeneratedFileSearchDocumentDraft[] = [];
    const repositories = createRepositories(written);
    const logger = createSilentLogger();

    const first = await backfillGeneratedFileSearchDocuments({
      repositories,
      logger,
      pageSize: 1
    });
    const second = await backfillGeneratedFileSearchDocuments({
      repositories,
      logger,
      pageSize: 1
    });

    expect(first).toEqual({
      knowledgeBaseCount: 2,
      releaseCount: 1,
      fileCount: 2
    });
    expect(second).toEqual(first);
    expect(written.map((document) => document.bundleFileId)).toEqual([
      "bundle-a",
      "bundle-b",
      "bundle-a",
      "bundle-b"
    ]);
    expect(written[0]).toMatchObject({
      knowledgeBaseId: "kb-indexed",
      releaseId: "release-indexed",
      logicalPath: "pages/a.md",
      fileKind: "page",
      title: "A",
      searchText: expect.stringContaining("pages/a.md")
    });
  });
});

function createRepositories(written: GeneratedFileSearchDocumentDraft[]): AdminRepositories {
  const knowledgeBases: KnowledgeBaseRecord[] = [
    {
      id: "kb-indexed",
      name: "Indexed",
      description: null,
      activeReleaseId: "release-indexed",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "kb-empty",
      name: "Empty",
      description: null,
      activeReleaseId: null,
      createdAt: now,
      updatedAt: now
    }
  ];
  const bundleFiles: BundleFileRecord[] = [
    createBundleFile("bundle-a", "pages/a.md", "A"),
    createBundleFile("bundle-b", "pages/b.md", "B")
  ];

  return {
    knowledgeBases: {
      async listKnowledgeBases({ limit, cursor }) {
        const start = cursor ? Number(cursor) : 0;
        const items = knowledgeBases.slice(start, start + limit);
        const nextCursor = start + limit < knowledgeBases.length ? String(start + limit) : null;
        return { items, nextCursor };
      },
      async createKnowledgeBase() {
        throw new Error("Not used by indexing tests");
      },
      async getKnowledgeBase() {
        throw new Error("Not used by indexing tests");
      }
    },
    files: {
      async listBundleTreeEntries() {
        throw new Error("Not used by indexing tests");
      },
      async getBundleFile() {
        throw new Error("Not used by indexing tests");
      },
      async listSourceFiles() {
        throw new Error("Not used by indexing tests");
      },
      async listReleases() {
        throw new Error("Not used by indexing tests");
      },
      async listBundleFiles({ limit, cursor }) {
        const start = cursor ? Number(cursor) : 0;
        const items = bundleFiles.slice(start, start + limit);
        const nextCursor = start + limit < bundleFiles.length ? String(start + limit) : null;
        return { items, nextCursor };
      },
      async upsertBundleFileSearchDocuments(documents) {
        written.push(...documents);
      }
    }
  };
}

function createBundleFile(id: string, logicalPath: string, title: string): BundleFileRecord {
  return {
    id,
    knowledgeBaseId: "kb-indexed",
    releaseId: "release-indexed",
    sourceFileId: `source-${id}`,
    fileKind: "page",
    logicalPath,
    objectKey: `tenant/kb/release/${logicalPath}`,
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 100,
    checksumSha256: "checksum",
    okfType: "page",
    title,
    description: "Description",
    tags: ["tag"],
    frontmatter: {
      title,
      description: "Description",
      secret: "hidden"
    }
  };
}

function createSilentLogger(): RuntimeLogger {
  return {
    error() {},
    warn() {},
    info() {},
    debug() {}
  };
}
