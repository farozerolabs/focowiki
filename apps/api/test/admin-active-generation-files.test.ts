import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "../src/config.js";
import { createApiApp } from "../src/server.js";
import type { StorageVnextAdminReadApplication } from
  "../src/storage-vnext/api/admin-read-application.js";
import type { StorageVnextAdminCoreApplication } from
  "../src/storage-vnext/api/admin-core-application.js";
import { createTestRedisCoordinator, loginAndReadSessionCookie } from "./support/session.js";

describe("Admin released file reads", () => {
  it("keeps tree, search ancestors, content, and relationship response shapes", async () => {
    const fixture = createFixture();
    const cookie = await loginAndReadSessionCookie(fixture.app);

    const tree = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-admin-active/files/tree?parentPath=pages",
      { headers: { cookie } }
    );
    expect(tree.status).toBe(200);
    const treeBody = await tree.json();
    expect(treeBody).toMatchObject({
      items: [
        {
          id: "directory:docs",
          entryType: "directory",
          logicalPath: "pages/docs",
          generatedFileId: null
        },
        {
          id: "source-a",
          entryType: "file",
          logicalPath: "pages/a.md",
          generatedFileId: "source-a"
        }
      ]
    });
    expect(JSON.stringify(treeBody)).not.toContain("bundleFileId");

    const search = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-admin-active/files/tree/search?query=guide",
      { headers: { cookie } }
    );
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      items: [{
        entry: { id: "source-guide", logicalPath: "pages/docs/guide.md" },
        ancestors: [{ id: "directory:docs", logicalPath: "pages/docs" }]
      }]
    });

    const detail = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-admin-active/files/detail?path=pages%2Fa.md&includeRelationships=1",
      { headers: { cookie } }
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({
      file: { id: "source-a", logicalPath: "pages/a.md", deletable: true },
      relationships: [{
        fileId: "source-guide",
        generatedFileId: "source-guide",
        path: "pages/docs/guide.md"
      }],
      content: "# A\n\nShared subject."
    });
    expect((detailBody as { file: Record<string, unknown> }).file).not.toHaveProperty(
      "checksumSha256"
    );
    expect(JSON.stringify(detailBody)).not.toContain("bundleFileId");
  });

  it("keeps stale tree cursors invalid after the released root changes", async () => {
    const fixture = createFixture();
    const cookie = await loginAndReadSessionCookie(fixture.app);
    const first = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-admin-active/files/tree?parentPath=pages&limit=1",
      { headers: { cookie } }
    );
    const cursor = (await first.json() as { nextCursor: string }).nextCursor;
    fixture.setRoot("root-b");

    const stale = await fixture.app.request(
      `/admin/api/knowledge-bases/kb-admin-active/files/tree?parentPath=pages&limit=1&cursor=${encodeURIComponent(cursor)}`,
      { headers: { cookie } }
    );

    expect(stale.status).toBe(400);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "INVALID_PAGINATION" }
    });
  });
});

function createFixture() {
  let rootId = "root-a";
  const directory = treeEntry({
    id: "directory:docs",
    name: "docs",
    logicalPath: "pages/docs",
    entryType: "directory"
  });
  const file = treeEntry({
    id: "source-a",
    name: "a.md",
    logicalPath: "pages/a.md",
    entryType: "file",
    generatedFileId: "source-a",
    sourceFileId: "source-a",
    deletable: true
  });
  const guide = treeEntry({
    id: "source-guide",
    name: "guide.md",
    logicalPath: "pages/docs/guide.md",
    parentPath: "pages/docs",
    entryType: "file",
    generatedFileId: "source-guide",
    sourceFileId: "source-guide",
    deletable: true
  });
  const adminRead: StorageVnextAdminReadApplication = {
    async listKnowledgeBases() {
      return { ok: true, value: { items: [], nextCursor: null } };
    },
    async getKnowledgeBase() {
      return { ok: false, code: "NOT_FOUND" };
    },
    async listTree(request) {
      if (request.cursor && request.cursor !== `cursor:${rootId}`) {
        return { ok: false, code: "INVALID_PAGINATION" };
      }
      const items = request.limit === 1 ? [directory] : [directory, file];
      return {
        ok: true,
        value: {
          items,
          nextCursor: request.limit === 1 ? `cursor:${rootId}` : null
        }
      };
    },
    async searchFiles() {
      return {
        ok: true,
        value: {
          items: [{ entry: guide, ancestors: [directory] }],
          nextCursor: null
        }
      };
    }
  };
  const adminCore: StorageVnextAdminCoreApplication = {
    ...unavailableCoreApplication(),
    async readGeneratedContent() {
      return {
        ok: true,
        value: {
          file: {
            id: "source-a",
            logicalPath: "pages/a.md",
            deletable: true
          },
          relationships: [{
            fileId: "source-guide",
            generatedFileId: "source-guide",
            path: "pages/docs/guide.md"
          }],
          content: "# A\n\nShared subject."
        }
      };
    }
  };
  return {
    app: createApiApp({
      config: testConfig(),
      redis: createTestRedisCoordinator(),
      storageVnextAdminRead: adminRead,
      storageVnextAdminCore: adminCore
    }),
    setRoot(value: string) {
      rootId = value;
    }
  };
}

function treeEntry(input: {
  id: string;
  name: string;
  logicalPath: string;
  parentPath?: string;
  entryType: "file" | "directory";
  generatedFileId?: string | null;
  sourceFileId?: string | null;
  deletable?: boolean;
}) {
  return {
    id: input.id,
    parentPath: input.parentPath ?? "pages",
    name: input.name,
    logicalPath: input.logicalPath,
    sortKey: input.logicalPath,
    entryType: input.entryType,
    generatedFileId: input.generatedFileId ?? null,
    sourceFileId: input.sourceFileId ?? null,
    sourceDirectoryId: input.entryType === "directory" ? input.id : null,
    fileKind: input.entryType === "file" ? "page" : null,
    directEntryCount: 0,
    directDirectoryCount: 0,
    directFileCount: 0,
    descendantFileCount: 0,
    resourceRevision: 1,
    deletable: input.deletable ?? false
  };
}

function unavailableCoreApplication(): StorageVnextAdminCoreApplication {
  const unavailable = async () => ({
    ok: false as const,
    code: "DATABASE_REPOSITORY_UNAVAILABLE" as const
  });
  return {
    createKnowledgeBase: unavailable,
    getKnowledgeBase: unavailable,
    deleteKnowledgeBase: unavailable,
    readGeneratedContent: unavailable,
    deleteSourceFile: unavailable,
    listFiles: unavailable,
    getFile: unavailable
  };
}

function testConfig() {
  return parseRuntimeConfig({
    APP_ENV: "development",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "admin-secret",
    DATABASE_URL: "postgres://focowiki:focowiki@127.0.0.1:55432/focowiki",
    REDIS_URL: "redis://127.0.0.1:56379/0",
    PUBLIC_BASE_URL: "https://openapi.example.com",
    S3_ENDPOINT: "https://s3.example.com",
    S3_REGION: "us-east-1",
    S3_BUCKET: "test",
    S3_ACCESS_KEY_ID: "test-access",
    S3_SECRET_ACCESS_KEY: "test-secret",
    S3_PREFIX: "test"
  });
}
