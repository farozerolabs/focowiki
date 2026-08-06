import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresStorageVnextEffectiveCatalog
} from "../src/storage-vnext/publication/effective-catalog.js";
import {
  createStorageVnextDirectoryNavigationShard
} from "../src/storage-vnext/publication/directory-state.js";
import {
  createPostgresStorageVnextPublicationSnapshot
} from "../src/storage-vnext/publication/postgres-snapshot.js";
import {
  createPostgresStorageVnextReleaseRepository
} from "../src/storage-vnext/release/postgres-repository.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;
const bootstrap = readFileSync(
  resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
  "utf8"
);

describeOwnedDatabase("storage vNext effective publication catalog", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_publication_${ownerToken}_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const releases = createPostgresStorageVnextReleaseRepository(sql);
  const effective = createPostgresStorageVnextEffectiveCatalog(sql);
  const directoryState = createStorageVnextDirectoryNavigationShard({
    directoryPath: "pages/guides",
    ordinal: 0,
    leaves: [{
      id: "directory-leaf-existing",
      previousLeafId: null,
      nextLeafId: null,
      revision: 3,
      entries: [{
        id: "source-guide",
        sortKey: "guide.md/source-guide",
        name: "guide.md",
        targetPath: "pages/guide.md",
        kind: "file"
      }]
    }]
  });
  const activeProjectionBody = Buffer.from(
    `${JSON.stringify({ records: [{ id: "active-projection" }] })}\n`,
    "utf8"
  );
  const candidateProjectionBody = Buffer.from(
    `${JSON.stringify({ records: [{ id: "candidate-projection" }] })}\n`,
    "utf8"
  );
  const snapshot = createPostgresStorageVnextPublicationSnapshot(sql, {
    objects: {
      async readVerified(input) {
        if (input.descriptor.checksum === directoryState.publicId.slice(-64)) {
          return directoryState.bytes;
        }
        if (input.descriptor.objectId === "object-active-4") {
          return activeProjectionBody;
        }
        if (input.descriptor.objectId === "object-candidate-reference") {
          return candidateProjectionBody;
        }
        throw new Error(`Unexpected test object: ${input.descriptor.objectId}`);
      }
    }
  });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await sql.unsafe(bootstrap);
    await seedCandidate();
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("overlays only candidate changes on the active catalog with bounded keyset pages", async () => {
    const items = [];
    let cursor: string | null = null;
    do {
      const page = await effective.listEffectiveCatalogEntries({
        knowledgeBaseId: "kb-publication",
        candidatePublicId: "candidate-publication",
        limit: 2,
        cursor
      });
      expect(page.items.length).toBeLessThanOrEqual(2);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(items.map((item) => item.logicalPath)).toEqual([
      "index.md",
      "pages/index.md",
      "schema.md",
      "log.md",
      "_index/index.md",
      "_graph/index.md",
      "pages/guide.md",
      "pages/reference.md"
    ]);
    expect(items.find((item) => item.logicalPath === "pages/guide.md")).toMatchObject({
      objectId: "object-candidate-guide",
      candidateOwned: true
    });
    expect(items.find((item) => item.logicalPath === "index.md")).toMatchObject({
      objectId: "object-active-0",
      candidateOwned: false
    });
    expect(items.filter((item) => item.candidateOwned)).toHaveLength(2);
  });

  it("checks link targets through the same candidate overlay and rejects foreign cursors", async () => {
    await expect(effective.findMissingLogicalPaths({
      knowledgeBaseId: "kb-publication",
      candidatePublicId: "candidate-publication",
      logicalPaths: ["index.md", "pages/reference.md", "pages/missing.md"]
    })).resolves.toEqual(["pages/missing.md"]);

    const first = await effective.listEffectiveCatalogEntries({
      knowledgeBaseId: "kb-publication",
      candidatePublicId: "candidate-publication",
      limit: 1,
      cursor: null
    });
    await expect(effective.listEffectiveCatalogEntries({
      knowledgeBaseId: "kb-publication",
      candidatePublicId: "candidate-other",
      limit: 1,
      cursor: first.nextCursor
    })).rejects.toThrow(/cursor/iu);
  });

  it("reads inherited directory navigation state through the candidate lineage", async () => {
    await expect(snapshot.readDirectoryLeaves({
      knowledgeBaseId: "kb-publication",
      candidatePublicId: "candidate-publication",
      directoryPath: "pages/guides",
      maximumBytes: 65_536,
      signal: new AbortController().signal
    })).resolves.toEqual([expect.objectContaining({
      id: "directory-leaf-existing",
      revision: 3
    })]);
  });

  it("resolves candidate-owned, inherited, and tombstoned projection paths", async () => {
    await expect(snapshot.readProjectionRecords({
      knowledgeBaseId: "kb-publication",
      candidatePublicId: "candidate-publication",
      logicalPath: "pages/reference.md",
      maximumBytes: 65_536,
      signal: new AbortController().signal
    })).resolves.toEqual([{ id: "candidate-projection" }]);

    await expect(snapshot.readProjectionRecords({
      knowledgeBaseId: "kb-publication",
      candidatePublicId: "candidate-publication",
      logicalPath: "_index/index.md",
      maximumBytes: 65_536,
      signal: new AbortController().signal
    })).resolves.toEqual([{ id: "active-projection" }]);

    await expect(snapshot.readProjectionRecords({
      knowledgeBaseId: "kb-publication",
      candidatePublicId: "candidate-publication",
      logicalPath: "_index/catalog.json",
      maximumBytes: 65_536,
      signal: new AbortController().signal
    })).resolves.toEqual([]);
  });

  it("keeps inherited entries and tombstones after the candidate becomes active", async () => {
    await sql.begin(async (transaction) => {
      await transaction`SET CONSTRAINTS focowiki.release_roots_role_key DEFERRED`;
      await transaction`
        UPDATE focowiki.release_roots
        SET root_role = 'base'
        WHERE public_id = 'root-active'
      `;
      await transaction`
        UPDATE focowiki.release_roots
        SET root_role = 'active', manifest_checksum_sha256 = ${"f".repeat(64)}
        WHERE public_id = 'root-candidate'
      `;
      await transaction`
        UPDATE focowiki.active_snapshots
        SET release_root_public_id = 'root-candidate',
            manifest_checksum_sha256 = ${"f".repeat(64)},
            revision = 2
        WHERE knowledge_base_id = 'kb-publication'
      `;
      await transaction`
        DELETE FROM focowiki.release_candidates
        WHERE public_id = 'candidate-publication'
      `;
    });

    const entries = [];
    let cursor: string | null = null;
    do {
      const page = await releases.listRootCatalogEntries({
        knowledgeBaseId: "kb-publication",
        releaseRootPublicId: "root-candidate",
        limit: 2,
        cursor
      });
      entries.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(entries.map((entry) => entry.logicalPath)).toEqual([
      "_graph/index.md",
      "_index/index.md",
      "index.md",
      "log.md",
      "pages/guide.md",
      "pages/index.md",
      "pages/reference.md",
      "schema.md"
    ]);
    expect(entries.find((entry) => entry.logicalPath === "pages/guide.md"))
      .toMatchObject({ objectId: "object-candidate-guide" });
    expect(entries.some((entry) => entry.logicalPath === "_index/catalog.json"))
      .toBe(false);
  });

  it("compacts a bounded lineage without restoring tombstoned paths", async () => {
    let baseRootPublicId = "root-active";
    for (let index = 2; index <= 6; index += 1) {
      const publicId = `root-base-${index}`;
      await sql`
        INSERT INTO focowiki.release_roots (
          public_id, knowledge_base_id, base_root_public_id, root_role,
          manifest_checksum_sha256, revision, created_at, expires_at
        ) VALUES (
          ${publicId}, 'kb-publication', ${baseRootPublicId}, 'base',
          ${"a".repeat(64)}, ${index}, now(), NULL
        )
      `;
      baseRootPublicId = publicId;
    }
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        created_at, updated_at
      ) VALUES (
        'root-expiring', 'kb-publication', 'publication',
        'publishing', now(), now()
      )
    `;
    await sql`
      INSERT INTO focowiki.release_roots (
        public_id, knowledge_base_id, base_root_public_id, root_role,
        manifest_checksum_sha256, revision, created_at, expires_at
      ) VALUES (
        'root-expiring', 'kb-publication', ${baseRootPublicId}, 'rollback',
        ${"a".repeat(64)}, 7, now(), '2026-08-03T00:00:00.000Z'
      )
    `;
    await sql`
      UPDATE focowiki.release_roots
      SET base_root_public_id = 'root-expiring'
      WHERE public_id = 'root-candidate' AND root_role = 'active'
    `;

    await expect(releases.expireRollbackRoot({
      knowledgeBaseId: "kb-publication",
      expiredBefore: "2026-08-04T00:00:00.000Z",
      eventPublicId: "event-lineage-compacted",
      eventExpiresAt: "2027-01-01T00:00:00.000Z"
    })).resolves.toBe("root-expiring");

    const roots = await sql<Array<{
      public_id: string;
      base_root_public_id: string | null;
      root_role: string;
    }>>`
      SELECT public_id, base_root_public_id, root_role
      FROM focowiki.release_roots
      WHERE knowledge_base_id = 'kb-publication'
    `;
    expect(roots).toEqual([{
      public_id: "root-candidate",
      base_root_public_id: null,
      root_role: "active"
    }]);

    const page = await releases.listRootCatalogEntries({
      knowledgeBaseId: "kb-publication",
      releaseRootPublicId: "root-candidate",
      limit: 20,
      cursor: null
    });
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((entry) => entry.logicalPath)).toEqual([
      "_graph/index.md",
      "_index/index.md",
      "index.md",
      "log.md",
      "pages/guide.md",
      "pages/index.md",
      "pages/reference.md",
      "schema.md"
    ]);
    expect(page.items.find((entry) => entry.logicalPath === "pages/guide.md"))
      .toMatchObject({ objectId: "object-candidate-guide" });
  });

  async function seedCandidate() {
    await sql`
      INSERT INTO focowiki.knowledge_bases (
        public_id, name, revision, created_at, updated_at
      ) VALUES ('kb-publication', 'Publication', 0, now(), now())
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state, created_at, updated_at
      ) VALUES (
        'operation-active', 'kb-publication', 'publication', 'publishing', now(), now()
      ), (
        'operation-publication', 'kb-publication', 'publication', 'publishing', now(), now()
      )
    `;
    await sql`
      INSERT INTO focowiki.operation_idempotency (
        public_id, knowledge_base_id, idempotency_key, request_hash,
        operation_public_id, expires_at, created_at
      ) VALUES (
        'idempotency-publication', 'kb-publication', 'publication-key',
        ${"1".repeat(64)}, 'operation-publication', '2027-01-01T00:00:00.000Z', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.release_roots (
        public_id, knowledge_base_id, root_role, manifest_checksum_sha256,
        revision, created_at, expires_at
      ) VALUES (
        'root-active', 'kb-publication', 'active', ${"a".repeat(64)}, 1, now(), NULL
      )
    `;
    await sql`
      INSERT INTO focowiki.search_projections (
        public_id, knowledge_base_id, projection_role, provider_index_uid,
        schema_checksum_sha256, settings_checksum_sha256,
        document_checksum_sha256, revision, document_count, state,
        created_at, updated_at
      ) VALUES (
        'search-active', 'kb-publication', 'active', 'run_owned_active',
        ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)},
        1, 1, 'ready', now(), now()
      )
    `;
    await sql`
      INSERT INTO focowiki.active_snapshots (
        knowledge_base_id, release_root_public_id, search_projection_public_id,
        manifest_checksum_sha256, revision, activated_by_operation_public_id,
        publicly_visible_at
      ) VALUES (
        'kb-publication', 'root-active', 'search-active', ${"a".repeat(64)},
        1, 'operation-active', now()
      )
    `;
    for (let ordinal = 0; ordinal < 8; ordinal += 1) {
      await createObject(
        `object-active-${ordinal}`,
        String(ordinal + 1).repeat(64).slice(0, 64),
        ordinal === 4 ? "okf-generated-json-v1" : "okf-generated-markdown-v1"
      );
    }
    const paths = [
      "index.md",
      "pages/index.md",
      "schema.md",
      "log.md",
      "_index/index.md",
      "_graph/index.md",
      "_index/catalog.json",
      "pages/guide.md"
    ];
    await sql`
      INSERT INTO focowiki.release_catalog_entries (
        knowledge_base_id, release_root_public_id, logical_path, entry_kind,
        source_file_public_id, checksum_sha256, object_id, byte_count, ordinal
      )
      SELECT * FROM unnest(
        ${paths.map(() => "kb-publication")}::text[],
        ${paths.map(() => "root-active")}::text[],
        ${paths}::text[],
        ${paths.map((path) => entryKind(path))}::text[],
        ${paths.map(() => null)}::text[],
        ${paths.map((_, ordinal) => String(ordinal + 1).repeat(64).slice(0, 64))}::text[],
        ${paths.map((_, ordinal) => `object-active-${ordinal}`)}::text[],
        ${paths.map(() => 100)}::bigint[],
        ${paths.map((_, ordinal) => ordinal)}::bigint[]
      )
    `;
    await releases.createCandidate({
      publicId: "candidate-publication",
      knowledgeBaseId: "kb-publication",
      operationPublicId: "operation-publication",
      candidateRootPublicId: "root-candidate",
      expectedActiveRootPublicId: "root-active",
      expectedActiveRevision: 1,
      changedFacts: [{ kind: "source_file", publicId: "source-guide", change: "updated" }],
      dependencies: [{ kind: "path", publicId: "pages/guide.md", reasonCode: "source_path" }],
      idempotency: { key: "publication-key", requestHash: "1".repeat(64) },
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    await createObject("object-candidate-guide", "e".repeat(64));
    await createObject(
      "object-candidate-reference",
      "f".repeat(64),
      "okf-generated-json-v1"
    );
    await releases.addCandidateCatalogEntries({
      candidatePublicId: "candidate-publication",
      entries: [
        {
          logicalPath: "pages/guide.md",
          kind: "index",
          sourceFilePublicId: null,
          checksum: "e".repeat(64),
          objectId: "object-candidate-guide",
          byteCount: 120,
          ordinal: 0
        },
        {
          logicalPath: "pages/reference.md",
          kind: "index",
          sourceFilePublicId: null,
          checksum: "f".repeat(64),
          objectId: "object-candidate-reference",
          byteCount: 130,
          ordinal: 1
        }
      ]
    });
    await releases.addCandidateCatalogTombstones({
      candidatePublicId: "candidate-publication",
      logicalPaths: ["_index/catalog.json"]
    });
    const directoryStateChecksum = directoryState.publicId.slice(-64);
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at, created_at
      ) VALUES (
        'object-directory-state', 'run-owned/object-directory-state',
        ${directoryStateChecksum}, ${directoryState.bytes.byteLength},
        'application/json; charset=utf-8', 'okf-generated-json-v1',
        'verified', 'attempt-directory-state', now(), now()
      )
    `;
    await releases.addCandidateShards({
      candidatePublicId: "candidate-publication",
      shards: [{
        publicId: directoryState.publicId,
        logicalKind: directoryState.logicalKind,
        firstLogicalPath: directoryState.firstLogicalPath,
        lastLogicalPath: directoryState.lastLogicalPath,
        recordCount: directoryState.recordCount,
        byteCount: directoryState.bytes.byteLength,
        checksum: directoryStateChecksum,
        objectId: "object-directory-state",
        ordinal: directoryState.ordinal
      }]
    });
  }

  async function createObject(
    objectId: string,
    checksum: string,
    objectFormat: "okf-generated-json-v1" | "okf-generated-markdown-v1"
      = "okf-generated-markdown-v1"
  ) {
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at, created_at
      ) VALUES (
        ${objectId}, ${`run-owned/${objectId}`}, ${checksum}, 100,
        ${objectFormat === "okf-generated-json-v1"
          ? "application/json; charset=utf-8"
          : "text/markdown; charset=utf-8"},
        ${objectFormat},
        'verified', ${`attempt-${objectId}`}, now(), now()
      )
    `;
  }
});

function entryKind(path: string) {
  if (path === "schema.md") return "schema";
  if (path === "log.md") return "log";
  if (path === "pages/index.md") return "directory";
  if (path.startsWith("_graph/")) return "graph";
  return "index";
}

function databaseConnectionUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
