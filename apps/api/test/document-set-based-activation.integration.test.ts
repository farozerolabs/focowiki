import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { applyPostgresDocumentDirectoryNavigation } from
  "../src/document-indexing/infrastructure/postgres-document-directory-navigation.js";
import { lockAndAdvanceScopedOwners } from
  "../src/document-indexing/infrastructure/postgres-scoped-activation-advance.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("set-based document activation persistence", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_set_activation_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('knowledge-base-set', 'Set persistence', 1)
    `;
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

  it("writes multiple directory leaves and entries with bounded set statements", async () => {
    await applyPostgresDocumentDirectoryNavigation({
      transaction: sql as unknown as DatabaseClient,
      knowledgeBaseId: "knowledge-base-set",
      activationRevision: 1,
      activatedAt: "2026-08-17T00:00:00.000Z",
      mutations: [{
        directoryPath: "pages/a",
        touchedLeaves: [leaf("leaf-a", "a"), leaf("leaf-b", "b")],
        removedLeafIds: []
      }, {
        directoryPath: "pages/b",
        touchedLeaves: [leaf("leaf-c", "c")],
        removedLeafIds: []
      }]
    });
    const initial = await counts();
    expect(initial).toEqual([{ leaves: 3, entries: 3 }]);

    await applyPostgresDocumentDirectoryNavigation({
      transaction: sql as unknown as DatabaseClient,
      knowledgeBaseId: "knowledge-base-set",
      activationRevision: 2,
      activatedAt: "2026-08-17T00:01:00.000Z",
      mutations: [{
        directoryPath: "pages/a",
        touchedLeaves: [leaf("leaf-a", "updated")],
        removedLeafIds: ["leaf-b"]
      }]
    });
    expect(await counts()).toEqual([{ leaves: 2, entries: 2 }]);
    const rows = await sql<Array<{ name: string; activation_revision: number | string }>>`
      SELECT entry.name, leaf.activation_revision
      FROM focowiki.generated_directory_leaf_entries entry
      JOIN focowiki.generated_directory_leaves leaf
        USING (knowledge_base_id, directory_path, leaf_public_id)
      WHERE entry.knowledge_base_id = 'knowledge-base-set'
        AND entry.directory_path = 'pages/a'
      ORDER BY entry.name
    `;
    expect(rows).toEqual([{ name: "updated", activation_revision: "2" }]);
  });

  it("locks and advances all scoped owners through set-based statements", async () => {
    const manifest = {
      knowledgeBaseId: "knowledge-base-set",
      readinessSequence: 3,
      activationOwners: [{
        kind: "source",
        key: "source-a",
        expectedVersion: 0,
        activeSourceRevisionPublicId: "revision-a",
        activePageCandidatePublicId: null
      }, {
        kind: "page_head",
        key: "pages/a.md",
        expectedVersion: 0,
        activeSourceRevisionPublicId: null,
        activePageCandidatePublicId: "candidate-a"
      }]
    };
    await lockAndAdvanceScopedOwners(
      sql as unknown as DatabaseClient,
      manifest as never,
      "2026-08-17T00:02:00.000Z"
    );
    const owners = await sql<Array<{
      owner_kind: string;
      owner_key: string;
      owner_version: number | string;
      active_source_revision_public_id: string | null;
      active_page_candidate_public_id: string | null;
    }>>`
      SELECT owner_kind, owner_key, owner_version,
             active_source_revision_public_id,
             active_page_candidate_public_id
      FROM focowiki.scoped_activation_owners
      WHERE knowledge_base_id = 'knowledge-base-set'
      ORDER BY owner_kind, owner_key
    `;
    expect(owners).toEqual([{
      owner_kind: "page_head",
      owner_key: "pages/a.md",
      owner_version: "1",
      active_source_revision_public_id: null,
      active_page_candidate_public_id: "candidate-a"
    }, {
      owner_kind: "source",
      owner_key: "source-a",
      owner_version: "1",
      active_source_revision_public_id: "revision-a",
      active_page_candidate_public_id: null
    }]);
    await expect(lockAndAdvanceScopedOwners(
      sql as unknown as DatabaseClient,
      manifest as never,
      "2026-08-17T00:03:00.000Z"
    )).rejects.toMatchObject({ code: "scoped_activation_conflict" });
  });

  function counts() {
    return sql<Array<{ leaves: number; entries: number }>>`
      SELECT
        (SELECT count(*)::integer
         FROM focowiki.generated_directory_leaves
         WHERE knowledge_base_id = 'knowledge-base-set') AS leaves,
        (SELECT count(*)::integer
         FROM focowiki.generated_directory_leaf_entries
         WHERE knowledge_base_id = 'knowledge-base-set') AS entries
    `;
  }
});

function leaf(id: string, name: string) {
  return {
    id,
    previousLeafId: null,
    nextLeafId: null,
    entries: [{
      id: `entry-${id}`,
      sortKey: name,
      name,
      targetPath: `pages/${name}.md`,
      kind: "file" as const
    }],
    revision: 1,
    changedAt: "2026-08-17T00:00:00.000Z"
  };
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
