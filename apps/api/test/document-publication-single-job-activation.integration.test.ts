import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentPublicationActivation } from
  "../src/document-indexing/infrastructure/postgres-document-publication-activation.js";
import { createPostgresDocumentPublicationJobRepository } from
  "../src/document-indexing/infrastructure/postgres-document-publication-job-repository.js";
import { readPostgresDocumentPublicationJobBasePages } from
  "../src/document-indexing/infrastructure/postgres-document-publication-job-base-pages.js";
import { DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION } from
  "../src/document-indexing/application/document-publication-renderer-contract.js";
import { fingerprintDocumentPublicationOutputs } from
  "../src/document-indexing/application/document-publication-manifest.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("single-job publication activation", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_single_activation_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 8 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await seedActiveDocument();
    await seedLargeDirectoryPages();
  }, 120_000);

  it("reads only the active base pages owned by the requested scope", async () => {
    const root = await readPostgresDocumentPublicationJobBasePages(database, {
      publicId: "base-root",
      knowledgeBaseId: "single-activation-kb",
      kind: "root",
      key: "index",
      requiredSequence: 1,
      renderedSequence: 0
    });
    const source = await readPostgresDocumentPublicationJobBasePages(database, {
      publicId: "base-source",
      knowledgeBaseId: "single-activation-kb",
      kind: "source",
      key: "single-activation-source",
      requiredSequence: 1,
      renderedSequence: 0
    });
    expect(root.map((page) => page.logicalPath)).toEqual(["index.md"]);
    expect(source.map((page) => page.logicalPath)).toEqual([
      "pages/active.md"
    ]);
  });

  it("does not load document bodies for large semantic directory navigation", async () => {
    const pages = await readPostgresDocumentPublicationJobBasePages(database, {
      publicId: "large-semantic-directory",
      knowledgeBaseId: "single-activation-kb",
      kind: "directory",
      key: "pages/large-directory",
      requiredSequence: 1,
      renderedSequence: 0
    });

    expect(pages).toEqual([]);
  });

  it("does not load graph documents for per-file directory navigation", async () => {
    const pages = await readPostgresDocumentPublicationJobBasePages(database, {
      publicId: "large-per-file-graph-directory",
      knowledgeBaseId: "single-activation-kb",
      kind: "_graph",
      key: "file-directory:pages/large-directory",
      requiredSequence: 1,
      renderedSequence: 0
    });

    expect(pages).toEqual([]);
  });

  it("keeps machine index and graph base resources available", async () => {
    const index = await readPostgresDocumentPublicationJobBasePages(database, {
      publicId: "large-machine-index-directory",
      knowledgeBaseId: "single-activation-kb",
      kind: "_index",
      key: "pages:pages/large-directory",
      requiredSequence: 1,
      renderedSequence: 0
    });
    const graph = await readPostgresDocumentPublicationJobBasePages(database, {
      publicId: "large-machine-graph-directory",
      knowledgeBaseId: "single-activation-kb",
      kind: "_graph",
      key: "directory:pages/large-directory",
      requiredSequence: 1,
      renderedSequence: 0
    });

    expect(index.map((page) => page.logicalPath)).toEqual([
      "_index/pages/large-directory/index.json"
    ]);
    expect(graph.map((page) => page.logicalPath)).toEqual([
      "_graph/by-directory/large-directory/index.json"
    ]);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("keeps the predecessor fully visible on rollback and commits once", async () => {
    const repository = createPostgresDocumentPublicationJobRepository(database);
    await repository.createItem({
      publicId: "single-activation-item",
      mutationPublicId: "single-activation-mutation",
      knowledgeBaseId: "single-activation-kb",
      documentJobPublicId: null,
      sourceFilePublicId: "single-activation-source",
      sourceRevisionPublicId: "single-activation-revision",
      operation: "delete",
      priorLogicalPath: "active.md",
      nextLogicalPath: null,
      affectedEvidence: {},
      readinessSequence: 1,
      createdAt: "2026-08-25T11:00:00.000Z"
    });
    const admitted = await repository.admitOne({
      now: "2026-08-25T11:00:02.000Z",
      rendererContractVersion: DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION
    });
    const claimed = await repository.claimOne({
      workerId: "single-activation-worker",
      now: "2026-08-25T11:00:03.000Z"
    });
    expect(claimed?.publicId).toBe(admitted?.publicId);
    const token = claimed!.attemptToken!;
    const outputs = [{
      normalizedPath: "index.md",
      logicalPath: "index.md",
      action: "put" as const,
      entryKind: "root-index",
      sourceFilePublicId: null,
      sourceRevisionPublicId: null,
      objectId: "single-activation-next-object",
      checksumSha256: "2".repeat(64),
      byteCount: 20,
      contentType: "text/markdown; charset=utf-8",
      producerFingerprintSha256: "8".repeat(64),
      navigationMutations: []
    }, {
      normalizedPath: "pages/active.md",
      logicalPath: "pages/active.md",
      action: "delete" as const,
      entryKind: null,
      sourceFilePublicId: null,
      sourceRevisionPublicId: null,
      objectId: null,
      checksumSha256: null,
      byteCount: null,
      contentType: null,
      producerFingerprintSha256: "7".repeat(64),
      navigationMutations: []
    }];
    await expect(repository.persistManifest({
      jobPublicId: claimed!.publicId,
      attemptToken: token,
      fingerprintSha256: fingerprintDocumentPublicationOutputs(outputs),
      outputs,
      persistedAt: "2026-08-25T11:00:04.000Z"
    })).resolves.toBe(true);

    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION focowiki.inject_activation_boundary_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'INJECTED_ACTIVATION_BOUNDARY_FAILURE';
      END;
      $$
    `);
    for (const table of [
      "knowledge_base_sequences",
      "generated_page_heads",
      "source_file_active_revisions",
      "document_projection_records",
      "knowledge_base_publication_heads",
      "publication_items",
      "publication_jobs"
    ]) {
      await sql.unsafe(`
        CREATE TRIGGER inject_activation_boundary_failure
        BEFORE INSERT OR UPDATE OR DELETE ON focowiki.${table}
        FOR EACH ROW EXECUTE FUNCTION
          focowiki.inject_activation_boundary_failure()
      `);
      try {
        const boundaryActivation = createPostgresDocumentPublicationActivation({
          sql: database
        });
        await expect(boundaryActivation.activate({
          jobPublicId: claimed!.publicId,
          attemptToken: token,
          activatedAt: "2026-08-25T11:00:04.500Z"
        })).rejects.toThrow("INJECTED_ACTIVATION_BOUNDARY_FAILURE");
      } finally {
        await sql.unsafe(`
          DROP TRIGGER IF EXISTS inject_activation_boundary_failure
          ON focowiki.${table}
        `);
      }
      await expect(readVisibleState()).resolves.toEqual({
        activeRevision: "0",
        currentSequence: "0",
        activeSourceRevisionPublicId: "single-activation-revision",
        activeProjectionCount: "1",
        indexObjectId: "single-activation-old-object",
        sourcePageCount: "1",
        itemOutcome: "pending",
        jobOutcome: "pending"
      });
    }
    for (const code of ["40P01", "40001", "55P03"]) {
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION focowiki.inject_activation_sqlstate_failure()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'INJECTED_ACTIVATION_SQLSTATE_FAILURE'
            USING ERRCODE = '${code}';
        END;
        $$
      `);
      await sql.unsafe(`
        CREATE TRIGGER inject_activation_sqlstate_failure
        BEFORE UPDATE ON focowiki.knowledge_base_publication_heads
        FOR EACH ROW EXECUTE FUNCTION
          focowiki.inject_activation_sqlstate_failure()
      `);
      try {
        const sqlstateActivation = createPostgresDocumentPublicationActivation({
          sql: database
        });
        await expect(sqlstateActivation.activate({
          jobPublicId: claimed!.publicId,
          attemptToken: token,
          activatedAt: "2026-08-25T11:00:04.600Z"
        })).rejects.toMatchObject({ code });
      } finally {
        await sql.unsafe(`
          DROP TRIGGER IF EXISTS inject_activation_sqlstate_failure
          ON focowiki.knowledge_base_publication_heads
        `);
      }
      await expect(readVisibleState()).resolves.toMatchObject({
        activeRevision: "0",
        currentSequence: "0",
        activeSourceRevisionPublicId: "single-activation-revision",
        activeProjectionCount: "1",
        itemOutcome: "pending",
        jobOutcome: "pending"
      });
    }

    const interrupted = createPostgresDocumentPublicationActivation({
      sql: database,
      beforeHeadAdvance: async () => {
        throw new Error("INJECTED_SINGLE_JOB_ROLLBACK");
      }
    });
    await expect(interrupted.activate({
      jobPublicId: claimed!.publicId,
      attemptToken: token,
      activatedAt: "2026-08-25T11:00:05.000Z"
    })).rejects.toThrow("INJECTED_SINGLE_JOB_ROLLBACK");
    await expect(readVisibleState()).resolves.toEqual({
      activeRevision: "0",
      currentSequence: "0",
      activeSourceRevisionPublicId: "single-activation-revision",
      activeProjectionCount: "1",
      indexObjectId: "single-activation-old-object",
      sourcePageCount: "1",
      itemOutcome: "pending",
      jobOutcome: "pending"
    });

    const activation = createPostgresDocumentPublicationActivation({
      sql: database
    });
    await expect(activation.activate({
      jobPublicId: claimed!.publicId,
      attemptToken: token,
      activatedAt: "2026-08-25T11:00:06.000Z"
    })).resolves.toMatchObject({
      knowledgeBaseId: "single-activation-kb",
      activeRevision: 1,
      documentCount: 0,
      putCount: 1,
      deleteCount: 1
    });
    await expect(readVisibleState()).resolves.toEqual({
      activeRevision: "1",
      currentSequence: "1",
      activeSourceRevisionPublicId: null,
      activeProjectionCount: "0",
      indexObjectId: "single-activation-next-object",
      sourcePageCount: "0",
      itemOutcome: "committed",
      jobOutcome: "committed"
    });
    await expect(activation.activate({
      jobPublicId: claimed!.publicId,
      attemptToken: token,
      activatedAt: "2026-08-25T11:00:07.000Z"
    })).resolves.toMatchObject({ activeRevision: 1 });
  });

  it("reclaims one job after a process stops at every publication boundary",
    async () => {
      const boundaries = [
        "closure_read",
        "object_write",
        "search_staging",
        "manifest_persistence",
        "before_activation",
        "activation_rollback"
      ] as const;

      for (const [index, boundary] of boundaries.entries()) {
        const fixture = await seedCrashBoundaryDocument(index, boundary);
        const repository = createPostgresDocumentPublicationJobRepository(database);
        await repository.createItem(fixture.item);
        const admitted = await repository.admitOne({
          now: fixture.admitAt,
          rendererContractVersion: DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION
        });
        const first = await repository.claimOne({
          workerId: `crash-worker-${boundary}`,
          now: fixture.firstClaimAt
        });
        expect(first?.publicId).toBe(admitted?.publicId);

        if (["manifest_persistence", "before_activation", "activation_rollback"]
          .includes(boundary)) {
          await expect(repository.persistManifest({
            jobPublicId: first!.publicId,
            attemptToken: first!.attemptToken!,
            fingerprintSha256:
              fingerprintDocumentPublicationOutputs(fixture.outputs),
            outputs: fixture.outputs,
            persistedAt: fixture.persistedAt
          })).resolves.toBe(true);
        }
        if (boundary === "activation_rollback") {
          const interrupted = createPostgresDocumentPublicationActivation({
            sql: database,
            beforeHeadAdvance: async () => {
              throw new Error("INJECTED_PROCESS_TERMINATION");
            }
          });
          await expect(interrupted.activate({
            jobPublicId: first!.publicId,
            attemptToken: first!.attemptToken!,
            activatedAt: fixture.interruptedAt
          })).rejects.toThrow("INJECTED_PROCESS_TERMINATION");
        }

        const reclaimed = await repository.claimOne({
          workerId: `recovery-worker-${boundary}`,
          now: fixture.reclaimAt
        });
        expect(reclaimed).toMatchObject({
          publicId: first!.publicId,
          attemptCount: 2
        });
        expect(reclaimed!.attemptToken).not.toBe(first!.attemptToken);
        await expect(repository.persistManifest({
          jobPublicId: first!.publicId,
          attemptToken: first!.attemptToken!,
          fingerprintSha256:
            fingerprintDocumentPublicationOutputs(fixture.outputs),
          outputs: fixture.outputs,
          persistedAt: fixture.recoveryPersistedAt
        })).resolves.toBe(false);
        await expect(createPostgresDocumentPublicationActivation({
          sql: database
        }).activate({
          jobPublicId: first!.publicId,
          attemptToken: first!.attemptToken!,
          activatedAt: fixture.recoveryActivatedAt
        })).rejects.toMatchObject({ code: "publication_attempt_fenced" });

        await expect(repository.persistManifest({
          jobPublicId: reclaimed!.publicId,
          attemptToken: reclaimed!.attemptToken!,
          fingerprintSha256:
            fingerprintDocumentPublicationOutputs(fixture.outputs),
          outputs: fixture.outputs,
          persistedAt: fixture.recoveryPersistedAt
        })).resolves.toBe(true);
        await expect(createPostgresDocumentPublicationActivation({
          sql: database
        }).activate({
          jobPublicId: reclaimed!.publicId,
          attemptToken: reclaimed!.attemptToken!,
          activatedAt: fixture.recoveryActivatedAt
        })).resolves.toMatchObject({ activeRevision: 1 });

        await expect(readCrashBoundaryState(fixture.knowledgeBaseId))
          .resolves.toEqual({
            activeRevision: "1",
            jobCount: "1",
            attemptCount: "2",
            committedJobCount: "1",
            outputCount: "2",
            acknowledgedSearchReceiptCount: "1"
          });
      }
    }, 120_000);

  async function seedActiveDocument(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('single-activation-kb', 'Single activation', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('single-activation-kb', 0)
    `;
    for (const object of [
      { id: "single-activation-source-object", checksum: "0".repeat(64), bytes: 30 },
      { id: "single-activation-old-object", checksum: "1".repeat(64), bytes: 10 },
      { id: "single-activation-next-object", checksum: "2".repeat(64), bytes: 20 }
    ]) {
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at
        ) VALUES (
          ${object.id}, ${`objects/${object.id}`}, ${object.checksum},
          ${object.bytes}, 'text/markdown; charset=utf-8',
          'okf-generated-markdown-v1', 'verified', ${`${object.id}-attempt`},
          '2026-08-25T10:59:00.000Z'
        )
      `;
    }
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision
      ) VALUES (
        'single-activation-source', 'single-activation-kb',
        'active.md', 'active.md', 'Active', '{}'::jsonb, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        'single-activation-revision', 'single-activation-kb',
        'single-activation-source', 'single-activation-source-object',
        ${"0".repeat(64)}, 30, 'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revision_presentations (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, metadata
      ) VALUES (
        'single-activation-kb', 'single-activation-source',
        'single-activation-revision', 'active.md', 'active.md',
        'Active', '{}'::jsonb
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES (
        'single-activation-kb', 'single-activation-source',
        'single-activation-revision', 'single-activation-revision', 0
      )
    `;
    await sql`
      INSERT INTO focowiki.document_projection_records (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, summary, metadata, headings,
        entities, content_type, checksum_sha256, byte_count,
        tokenizer_contract_version, navigation_term_fingerprint_sha256,
        active
      ) VALUES (
        'single-activation-kb', 'single-activation-source',
        'single-activation-revision', 'active.md', 'active.md',
        'Active', 'Active summary', '{}'::jsonb, '{}'::text[], '{}'::text[],
        'text/markdown; charset=utf-8', ${"0".repeat(64)}, 30,
        'tokenizer-v1', ${"3".repeat(64)}, true
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_candidate_public_id, object_id, checksum_sha256, byte_count,
        activation_revision
      ) VALUES
        ('single-activation-kb', 'index.md', 'index.md', 'root-index',
         NULL, NULL, NULL, 'single-activation-old-object', ${"1".repeat(64)},
         10, 0),
        ('single-activation-kb', 'pages/active.md', 'pages/active.md',
         'source-page', 'single-activation-source',
         'single-activation-revision', NULL, 'single-activation-source-object',
         ${"0".repeat(64)}, 30, 0)
    `;
  }

  async function seedLargeDirectoryPages(): Promise<void> {
    await sql.unsafe(`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_candidate_public_id, object_id, checksum_sha256, byte_count,
        activation_revision
      )
      SELECT
        'single-activation-kb',
        'pages/large-directory/document-' || lpad(sequence::text, 5, '0')
          || '.md',
        'pages/large-directory/document-' || lpad(sequence::text, 5, '0')
          || '.md',
        'source-page', NULL, NULL, NULL, 'single-activation-old-object',
        '${"1".repeat(64)}', 10, 0
      FROM generate_series(1, 10001) AS sequence
    `);
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_candidate_public_id, object_id, checksum_sha256, byte_count,
        activation_revision
      ) VALUES
      (
        'single-activation-kb',
        '_graph/by-file/large-directory/document.json',
        '_graph/by-file/large-directory/document.json',
        'graph-file', NULL, NULL, NULL, 'single-activation-old-object',
        ${"1".repeat(64)}, 10, 0
      ),
      (
        'single-activation-kb',
        '_index/pages/large-directory/index.json',
        '_index/pages/large-directory/index.json',
        'machine-index', NULL, NULL, NULL, 'single-activation-old-object',
        ${"1".repeat(64)}, 10, 0
      ),
      (
        'single-activation-kb',
        '_graph/by-directory/large-directory/index.json',
        '_graph/by-directory/large-directory/index.json',
        'graph-index', NULL, NULL, NULL, 'single-activation-old-object',
        ${"1".repeat(64)}, 10, 0
      )
    `;
  }

  async function seedCrashBoundaryDocument(
    index: number,
    boundary: string
  ) {
    const identity = String(index + 1).padStart(2, "0");
    const knowledgeBaseId = `crash-boundary-kb-${identity}`;
    const sourceFilePublicId = `crash-boundary-source-${identity}`;
    const sourceRevisionPublicId = `crash-boundary-revision-${identity}`;
    const sourceObjectId = `crash-boundary-source-object-${identity}`;
    const priorObjectId = `crash-boundary-prior-object-${identity}`;
    const nextObjectId = `crash-boundary-next-object-${identity}`;
    const sourceChecksum = `${identity[0] ?? "0"}`.repeat(64);
    const priorChecksum = `${identity[1] ?? "1"}`.repeat(64);
    const nextChecksum = `${(index + 3) % 10}`.repeat(64);
    const baseMinute = index * 2;
    const at = (minutes: number, seconds: number) =>
      new Date(Date.UTC(2026, 7, 25, 12, baseMinute + minutes, seconds))
        .toISOString();

    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES (${knowledgeBaseId}, ${`Crash boundary ${boundary}`}, 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES (${knowledgeBaseId}, 0)
    `;
    for (const object of [
      { id: sourceObjectId, checksum: sourceChecksum, bytes: 30 },
      { id: priorObjectId, checksum: priorChecksum, bytes: 10 },
      { id: nextObjectId, checksum: nextChecksum, bytes: 20 }
    ]) {
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at
        ) VALUES (
          ${object.id}, ${`objects/${object.id}`}, ${object.checksum},
          ${object.bytes}, 'text/markdown; charset=utf-8',
          'okf-generated-markdown-v1', 'verified',
          ${`${object.id}-attempt`}, ${at(0, 0)}
        )
      `;
    }
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision
      ) VALUES (
        ${sourceFilePublicId}, ${knowledgeBaseId}, 'active.md', 'active.md',
        ${`Active ${identity}`}, '{}'::jsonb, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        ${sourceRevisionPublicId}, ${knowledgeBaseId}, ${sourceFilePublicId},
        ${sourceObjectId}, ${sourceChecksum}, 30,
        'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES (
        ${knowledgeBaseId}, ${sourceFilePublicId}, ${sourceRevisionPublicId},
        ${sourceRevisionPublicId}, 0
      )
    `;
    await sql`
      INSERT INTO focowiki.document_projection_records (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, summary, metadata, headings,
        entities, content_type, checksum_sha256, byte_count,
        tokenizer_contract_version, navigation_term_fingerprint_sha256,
        active
      ) VALUES (
        ${knowledgeBaseId}, ${sourceFilePublicId}, ${sourceRevisionPublicId},
        'active.md', 'active.md', ${`Active ${identity}`}, 'Active summary',
        '{}'::jsonb, '{}'::text[], '{}'::text[],
        'text/markdown; charset=utf-8', ${sourceChecksum}, 30,
        'tokenizer-v1', ${nextChecksum}, true
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_candidate_public_id, object_id, checksum_sha256, byte_count,
        activation_revision
      ) VALUES
        (${knowledgeBaseId}, 'index.md', 'index.md', 'root-index',
         NULL, NULL, NULL, ${priorObjectId}, ${priorChecksum}, 10, 0),
        (${knowledgeBaseId}, 'pages/active.md', 'pages/active.md',
         'source-page', ${sourceFilePublicId}, ${sourceRevisionPublicId},
         NULL, ${sourceObjectId}, ${sourceChecksum}, 30, 0)
    `;
    await sql`
      INSERT INTO focowiki.search_family_receipts (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, provider_kind, family,
        input_fingerprint_sha256, provider_document_ids, state,
        acknowledged_at
      ) VALUES (
        ${`crash-search-receipt-${identity}`}, ${knowledgeBaseId},
        ${sourceFilePublicId}, ${sourceRevisionPublicId}, 'opensearch',
        'relation_evidence', ${nextChecksum},
        ${sql.array([`crash-search-document-${identity}`])},
        'acknowledged', ${at(0, 1)}
      )
    `;
    const outputs = [{
      normalizedPath: "index.md",
      logicalPath: "index.md",
      action: "put" as const,
      entryKind: "root-index",
      sourceFilePublicId: null,
      sourceRevisionPublicId: null,
      objectId: nextObjectId,
      checksumSha256: nextChecksum,
      byteCount: 20,
      contentType: "text/markdown; charset=utf-8",
      producerFingerprintSha256: nextChecksum,
      navigationMutations: []
    }, {
      normalizedPath: "pages/active.md",
      logicalPath: "pages/active.md",
      action: "delete" as const,
      entryKind: null,
      sourceFilePublicId: null,
      sourceRevisionPublicId: null,
      objectId: null,
      checksumSha256: null,
      byteCount: null,
      contentType: null,
      producerFingerprintSha256: priorChecksum,
      navigationMutations: []
    }];
    return {
      knowledgeBaseId,
      item: {
        publicId: `crash-boundary-item-${identity}`,
        mutationPublicId: `crash-boundary-mutation-${identity}`,
        knowledgeBaseId,
        documentJobPublicId: null,
        sourceFilePublicId,
        sourceRevisionPublicId,
        operation: "delete" as const,
        priorLogicalPath: "active.md",
        nextLogicalPath: null,
        affectedEvidence: {},
        readinessSequence: 1,
        createdAt: at(0, 2)
      },
      outputs,
      admitAt: at(0, 4),
      firstClaimAt: at(0, 5),
      persistedAt: at(0, 6),
      interruptedAt: at(0, 7),
      reclaimAt: at(30, 6),
      recoveryPersistedAt: at(30, 7),
      recoveryActivatedAt: at(30, 8)
    };
  }

  async function readCrashBoundaryState(knowledgeBaseId: string) {
    const rows = await sql<Array<{
      active_revision: number | string;
      job_count: number | string;
      attempt_count: number | string;
      committed_job_count: number | string;
      output_count: number | string;
      acknowledged_search_receipt_count: number | string;
    }>>`
      SELECT head.active_revision,
             count(DISTINCT job.public_id) AS job_count,
             max(job.attempt_count) AS attempt_count,
             count(DISTINCT job.public_id)
               FILTER (WHERE job.outcome = 'committed') AS committed_job_count,
             count(DISTINCT output.normalized_path) AS output_count,
             count(DISTINCT receipt.public_id)
               FILTER (WHERE receipt.state = 'acknowledged')
                 AS acknowledged_search_receipt_count
      FROM focowiki.knowledge_base_publication_heads head
      JOIN focowiki.publication_jobs job
        ON job.knowledge_base_id = head.knowledge_base_id
      JOIN focowiki.publication_job_outputs output
        ON output.job_public_id = job.public_id
      LEFT JOIN focowiki.search_family_receipts receipt
        ON receipt.knowledge_base_id = head.knowledge_base_id
      WHERE head.knowledge_base_id = ${knowledgeBaseId}
      GROUP BY head.active_revision
    `;
    const row = rows[0]!;
    return {
      activeRevision: String(row.active_revision),
      jobCount: String(row.job_count),
      attemptCount: String(row.attempt_count),
      committedJobCount: String(row.committed_job_count),
      outputCount: String(row.output_count),
      acknowledgedSearchReceiptCount:
        String(row.acknowledged_search_receipt_count)
    };
  }

  async function readVisibleState() {
    const rows = await sql<Array<{
      active_revision: number | string;
      current_sequence: number | string;
      active_source_revision_public_id: string | null;
      active_projection_count: number | string;
      index_object_id: string;
      source_page_count: number | string;
      item_outcome: string;
      job_outcome: string;
    }>>`
      SELECT head.active_revision,
             sequence.current_sequence,
             active.active_source_revision_public_id,
             count(DISTINCT projection.source_revision_public_id)
               FILTER (WHERE projection.active) AS active_projection_count,
             root.object_id AS index_object_id,
             count(source_page.normalized_path) AS source_page_count,
             item.outcome AS item_outcome, job.outcome AS job_outcome
      FROM focowiki.knowledge_base_publication_heads head
      JOIN focowiki.knowledge_base_sequences sequence
        ON sequence.knowledge_base_id = head.knowledge_base_id
      JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = head.knowledge_base_id
      JOIN focowiki.generated_page_heads root
        ON root.knowledge_base_id = head.knowledge_base_id
       AND root.normalized_path = 'index.md'
      LEFT JOIN focowiki.generated_page_heads source_page
        ON source_page.knowledge_base_id = head.knowledge_base_id
       AND source_page.normalized_path = 'pages/active.md'
      LEFT JOIN focowiki.document_projection_records projection
        ON projection.knowledge_base_id = head.knowledge_base_id
      JOIN focowiki.publication_items item
        ON item.public_id = 'single-activation-item'
      JOIN focowiki.publication_job_items membership
        ON membership.item_public_id = item.public_id
      JOIN focowiki.publication_jobs job
        ON job.public_id = membership.job_public_id
      WHERE head.knowledge_base_id = 'single-activation-kb'
      GROUP BY head.active_revision, sequence.current_sequence,
               active.active_source_revision_public_id,
               root.object_id, item.outcome, job.outcome
    `;
    const row = rows[0]!;
    return {
      activeRevision: String(row.active_revision),
      currentSequence: String(row.current_sequence),
      activeSourceRevisionPublicId: row.active_source_revision_public_id,
      activeProjectionCount: String(row.active_projection_count),
      indexObjectId: row.index_object_id,
      sourcePageCount: String(row.source_page_count),
      itemOutcome: row.item_outcome,
      jobOutcome: row.job_outcome
    };
  }
});

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
