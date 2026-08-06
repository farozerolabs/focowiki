import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext cross-scope database constraints", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_constraints_${ownerToken}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await sql.unsafe(readFileSync(
      resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
      "utf8"
    ));
    await sql`
      INSERT INTO focowiki.knowledge_bases
        (public_id, name, revision)
      VALUES
        ('kb-a', 'Knowledge base A', 1),
        ('kb-b', 'Knowledge base B', 1)
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

  it("rejects a parent directory from another knowledge base", async () => {
    await sql`
      INSERT INTO focowiki.source_directories
        (public_id, knowledge_base_id, logical_path, normalized_path, title, revision)
      VALUES ('dir-a', 'kb-a', 'a', 'a', 'A', 1)
    `;

    await expect(sql`
      INSERT INTO focowiki.source_directories
        (public_id, knowledge_base_id, parent_public_id, logical_path, normalized_path, title, revision)
      VALUES ('dir-b', 'kb-b', 'dir-a', 'b/child', 'b/child', 'Child', 1)
    `).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects a graph edge whose endpoint belongs to another knowledge base", async () => {
    await createSourceGraphFixture(sql, "a", "kb-a");
    await createSourceGraphFixture(sql, "b", "kb-b");

    await expect(sql`
      INSERT INTO focowiki.graph_edges
        (public_id, knowledge_base_id, from_node_public_id, to_node_public_id,
         relation, weight, edge_source, metadata, revision)
      VALUES (
        'edge-cross', 'kb-a', 'node-a', 'node-b',
        'references', 1, 'deterministic', '{}'::jsonb, 1
      )
    `).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects active search and release pointers from another scope", async () => {
    await sql`
      INSERT INTO focowiki.release_roots
        (public_id, knowledge_base_id, root_role, manifest_checksum_sha256, revision)
      VALUES ('root-a', 'kb-a', 'active', ${"a".repeat(64)}, 1)
    `;
    await sql`
      INSERT INTO focowiki.search_projections
        (public_id, knowledge_base_id, projection_role, provider_index_uid,
         schema_checksum_sha256, settings_checksum_sha256,
         document_checksum_sha256, revision, document_count, state)
      VALUES ('search-b', 'kb-b', 'active', 'owned-search-b',
        ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)}, 1, 0, 'ready')
    `;
    await sql`
      INSERT INTO focowiki.operations
        (public_id, knowledge_base_id, operation_kind, state)
      VALUES ('operation-a', 'kb-a', 'publication', 'accepted')
    `;

    await expect(sql`
      INSERT INTO focowiki.active_snapshots
        (knowledge_base_id, release_root_public_id, search_projection_public_id,
         manifest_checksum_sha256, revision, activated_by_operation_public_id,
         publicly_visible_at)
      VALUES ('kb-a', 'root-a', 'search-b', ${"a".repeat(64)}, 1, 'operation-a', now())
    `).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects a second source revision identity for the same file content", async () => {
    await createSourceGraphFixture(sql, "c", "kb-a");
    await expect(sql`
      INSERT INTO focowiki.source_revisions
        (public_id, knowledge_base_id, source_file_public_id, object_id,
         checksum_sha256, byte_count, content_type, revision_role, expires_at)
      VALUES ('revision-c-duplicate', 'kb-a', 'file-c', 'object-c',
        ${"c".repeat(64)}, 1, 'text/markdown', 'candidate',
        '2027-01-01T00:00:00.000Z')
    `).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects an oversized bounded metadata payload", async () => {
    await expect(sql`
      INSERT INTO focowiki.source_files
        (public_id, knowledge_base_id, logical_path, normalized_path, title,
         metadata, status, revision)
      VALUES ('file-oversized', 'kb-a', 'large.md', 'large.md', 'Large',
        ${sql.json({ value: "x".repeat(9_000) })}, 'ready', 1)
    `).rejects.toMatchObject({ code: "23514" });
  });
});

async function createSourceGraphFixture(
  sql: ReturnType<typeof postgres>,
  suffix: string,
  knowledgeBaseId: string
): Promise<void> {
  await sql`
    INSERT INTO focowiki.source_files
      (public_id, knowledge_base_id, logical_path, normalized_path, title, status, revision)
    VALUES (${`file-${suffix}`}, ${knowledgeBaseId}, ${`${suffix}.md`},
      ${`${suffix}.md`}, ${suffix.toUpperCase()}, 'ready', 1)
  `;
  await sql`
    INSERT INTO focowiki.object_registrations
      (object_id, storage_key, checksum_sha256, byte_count, content_type,
       object_format, state, write_attempt_public_id, verified_at)
    VALUES (${`object-${suffix}`}, ${`owned/${suffix}`}, ${suffix.repeat(64)}, 1,
      'text/markdown', 'source-markdown', 'verified', ${`write-${suffix}`}, now())
  `;
  await sql`
    INSERT INTO focowiki.source_revisions
      (public_id, knowledge_base_id, source_file_public_id, object_id,
       checksum_sha256, byte_count, content_type, revision_role)
    VALUES (${`revision-${suffix}`}, ${knowledgeBaseId}, ${`file-${suffix}`},
      ${`object-${suffix}`}, ${suffix.repeat(64)}, 1, 'text/markdown', 'current')
  `;
  await sql`
    INSERT INTO focowiki.graph_nodes
      (public_id, knowledge_base_id, source_file_public_id, source_revision_public_id,
       logical_path, label, node_kind, revision)
    VALUES (${`node-${suffix}`}, ${knowledgeBaseId}, ${`file-${suffix}`},
      ${`revision-${suffix}`}, ${`${suffix}.md`}, ${suffix.toUpperCase()}, 'file', 1)
  `;
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
