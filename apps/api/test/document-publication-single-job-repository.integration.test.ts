import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentPublicationJobRepository } from
  "../src/document-indexing/infrastructure/postgres-document-publication-job-repository.js";
import { createPostgresReadyDocumentPublicationItem } from
  "../src/document-indexing/infrastructure/postgres-document-publication-item-repository.js";
import { readPublicationJobFactDeltas } from
  "../src/document-indexing/infrastructure/postgres-document-publication-job-deltas.js";
import { fingerprintDocumentPublicationOutputs } from
  "../src/document-indexing/application/document-publication-manifest.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("single-job publication repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_single_publication_${
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
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('single-job-kb', 'Single job', 1),
             ('single-job-other-kb', 'Other job', 1)
    `;
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("freezes membership once and leaves later arrivals pending", async () => {
    const repository = createPostgresDocumentPublicationJobRepository(database);
    for (let index = 0; index < 257; index += 1) {
      await repository.createItem(item(index));
    }
    await expect(readPendingHead("single-job-kb")).resolves.toMatchObject({
      pending_item_count: "257"
    });
    const job = await repository.admitOne({
      now: "2026-08-25T10:00:02.000Z",
      rendererContractVersion: "portable-okf-v2"
    });
    expect(job?.items).toHaveLength(256);
    expect(job?.settingsSnapshot).toEqual({
      schemaVersion: "document-publication-settings-v1",
      rendererContractVersion: "portable-okf-v2",
      runtimeSettingsRevisionPublicIds: ["settings-revision-1"],
      generationModelConfigurationPublicIds: ["generation-model-1"],
      generationModelConfigurationRevisions: [2],
      embeddingConfigurationRevisionPublicIds: ["embedding-revision-1"],
      semanticGenerationPublicIds: ["semantic-generation-1"],
      semanticContractVersions: ["semantic-contract-v1"]
    });
    expect(job?.items[0]?.publicId).toBe("publication-item-000");
    expect(job?.items.at(-1)?.publicId).toBe("publication-item-255");
    await expect(readPendingHead("single-job-kb")).resolves.toMatchObject({
      pending_item_count: "1"
    });

    await repository.createItem(item(999));
    await expect(readPendingHead("single-job-kb")).resolves.toMatchObject({
      pending_item_count: "2"
    });
    expect((await repository.readJob(job!.publicId))?.items).toEqual(job?.items);
    await expect(sql<Array<{ public_id: string }>>`
      SELECT public_id FROM focowiki.publication_items
      WHERE outcome = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.publication_job_items membership
          WHERE membership.item_public_id = publication_items.public_id
        )
      ORDER BY readiness_sequence, public_id COLLATE "C"
    `).resolves.toEqual([
      { public_id: "publication-item-256" },
      { public_id: "publication-item-999" }
    ]);
    await expect(repository.admitOne({
      now: "2026-08-25T10:00:03.000Z",
      rendererContractVersion: "portable-okf-v2"
    })).resolves.toBeNull();
  });

  it("fences races, repeated starts, process exit, and stale writers",
    async () => {
    const repository = createPostgresDocumentPublicationJobRepository(database);
    const raced = await Promise.all([
      repository.claimOne({
        workerId: "worker-a",
        now: "2026-08-25T10:01:00.000Z"
      }),
      repository.claimOne({
        workerId: "worker-b",
        now: "2026-08-25T10:01:00.000Z"
      })
    ]);
    const winners = raced.filter((entry) => entry !== null);
    expect(winners).toHaveLength(1);
    const first = winners[0]!;
    expect(first).toMatchObject({
      attemptCount: 1,
      attemptDeadline: "2026-08-25T10:02:30.000Z"
    });
    await expect(repository.renewAttempt({
      jobPublicId: first.publicId,
      attemptToken: first.attemptToken!,
      renewedAt: "2026-08-25T10:02:00.000Z"
    })).resolves.toBe("2026-08-25T10:03:30.000Z");
    await expect(repository.claimOne({
      workerId: "worker-b",
      now: "2026-08-25T10:03:29.999Z"
    })).resolves.toBeNull();
    await expect(repository.claimOne({
      workerId: "worker-a",
      now: "2026-08-25T10:03:29.999Z"
    })).resolves.toBeNull();
    // No shutdown write is required. An exited owner is reclaimed at the
    // fixed database-time deadline on the same durable job.
    const reclaimed = await repository.claimOne({
      workerId: "worker-b",
      now: "2026-08-25T10:03:30.001Z"
    });
    expect(reclaimed).toMatchObject({
      publicId: first?.publicId,
      attemptCount: 2,
      attemptDeadline: "2026-08-25T10:05:00.001Z"
    });
    expect(reclaimed?.attemptToken).not.toBe(first?.attemptToken);

    await expect(repository.persistManifest({
      jobPublicId: first!.publicId,
      attemptToken: first!.attemptToken!,
      fingerprintSha256: fingerprintDocumentPublicationOutputs([]),
      outputs: [],
      persistedAt: "2026-08-25T10:03:31.000Z"
    })).resolves.toBe(false);
    await expect(repository.persistManifest({
      jobPublicId: reclaimed!.publicId,
      attemptToken: reclaimed!.attemptToken!,
      fingerprintSha256: "b".repeat(64),
      outputs: [],
      persistedAt: "2026-08-25T10:03:31.000Z"
    })).rejects.toMatchObject({
      code: "publication_manifest_fingerprint_invalid"
    });
    await expect(repository.persistManifest({
      jobPublicId: reclaimed!.publicId,
      attemptToken: reclaimed!.attemptToken!,
      fingerprintSha256: fingerprintDocumentPublicationOutputs([]),
      outputs: [],
      persistedAt: "2026-08-25T10:03:31.000Z"
    })).resolves.toBe(true);
  });

  it("terminates after three attempts and releases knowledge-base ownership",
    async () => {
      const repository = createPostgresDocumentPublicationJobRepository(database);
      const job = await repository.readNonterminalJob("single-job-kb");
      expect(job).not.toBeNull();
      const second = await repository.failAttempt({
        jobPublicId: job!.publicId,
        attemptToken: job!.attemptToken!,
        failedAt: "2026-08-25T10:03:32.000Z",
        errorCode: "search_provider_unavailable",
        retryable: true
      });
      expect(second).toBe("retrying");
      const thirdClaim = await repository.claimOne({
        workerId: "worker-c",
        now: "2026-08-25T10:03:34.000Z"
      });
      expect(thirdClaim?.attemptCount).toBe(3);
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at
        ) VALUES
        (
          'replaced-job-output-object',
          'objects/replaced-job-output-object', ${"5".repeat(64)}, 11,
          'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
          'verified', 'replaced-job-output-attempt',
          '2026-08-25T10:03:34.000Z'
        ),
        (
          'terminal-job-output-object',
          'objects/terminal-job-output-object', ${"6".repeat(64)}, 12,
          'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
          'verified', 'terminal-job-output-attempt',
          '2026-08-25T10:03:34.000Z'
        )
      `;
      const replacedOutput = [publicationOutput({
        normalizedPath: "replaced.md",
        objectId: "replaced-job-output-object",
        checksumSha256: "5".repeat(64),
        byteCount: 11,
        producerFingerprintSha256: "5".repeat(64)
      })];
      await expect(repository.persistManifest({
        jobPublicId: thirdClaim!.publicId,
        attemptToken: thirdClaim!.attemptToken!,
        fingerprintSha256:
          fingerprintDocumentPublicationOutputs(replacedOutput),
        outputs: replacedOutput,
        persistedAt: "2026-08-25T10:03:34.200Z"
      })).resolves.toBe(true);
      const terminalOutput = [publicationOutput({
        normalizedPath: "terminal.md",
        objectId: "terminal-job-output-object",
        checksumSha256: "6".repeat(64),
        byteCount: 12,
        producerFingerprintSha256: "6".repeat(64)
      })];
      await expect(repository.persistManifest({
        jobPublicId: thirdClaim!.publicId,
        attemptToken: thirdClaim!.attemptToken!,
        fingerprintSha256:
          fingerprintDocumentPublicationOutputs(terminalOutput),
        outputs: terminalOutput,
        persistedAt: "2026-08-25T10:03:34.500Z"
      })).resolves.toBe(true);
      await expect(sql<Array<{ state: string }>>`
        SELECT state FROM focowiki.cleanup_actions
        WHERE resource_public_id = 'replaced-job-output-object'
          AND action_kind = 'zero_owner_object'
      `).resolves.toEqual([{ state: "queued" }]);
      await expect(repository.failAttempt({
        jobPublicId: thirdClaim!.publicId,
        attemptToken: thirdClaim!.attemptToken!,
        failedAt: "2026-08-25T10:03:35.000Z",
        errorCode: "search_provider_unavailable",
        retryable: true
      })).resolves.toBe("failed");
      await expect(sql<Array<{
        zero_owner_since: Date | string | null;
        cleanup_state: string | null;
      }>>`
        SELECT registration.zero_owner_since,
               cleanup.state AS cleanup_state
        FROM focowiki.object_registrations registration
        LEFT JOIN focowiki.cleanup_actions cleanup
          ON cleanup.resource_public_id = registration.object_id
         AND cleanup.action_kind = 'zero_owner_object'
        WHERE registration.object_id = 'terminal-job-output-object'
      `).resolves.toMatchObject([{
        zero_owner_since: expect.anything(),
        cleanup_state: "queued"
      }]);

      const successor = await repository.admitOne({
        now: "2026-08-25T10:03:36.000Z",
        rendererContractVersion: "portable-okf-v2"
      });
      expect(successor?.items.map((entry) => entry.publicId)).toEqual([
        "publication-item-256", "publication-item-999"
      ]);
    });

  it("rejects obsolete revisions and supersedes older pending source work",
    async () => {
      await seedCurrentRevision();
      const repository = createPostgresDocumentPublicationJobRepository(database);
      await repository.createItem({
        publicId: "obsolete-pending-item",
        mutationPublicId: "obsolete-pending-mutation",
        knowledgeBaseId: "single-current-kb",
        documentJobPublicId: null,
        sourceFilePublicId: "single-current-source",
        sourceRevisionPublicId: "single-current-old-revision",
        operation: "replace",
        priorLogicalPath: "old.md",
        nextLogicalPath: "old.md",
        affectedEvidence: {},
        readinessSequence: 1,
        createdAt: "2026-08-25T12:00:00.000Z"
      });
      await expect(createPostgresReadyDocumentPublicationItem({
        transaction: database,
        knowledgeBaseId: "single-current-kb",
        mutationPublicId: "stale-mutation",
        documentJobPublicId: null,
        sourceFilePublicId: "single-current-source",
        sourceRevisionPublicId: "single-current-old-revision",
        operation: "replace",
        affectedEvidence: {},
        createdAt: "2026-08-25T12:00:01.000Z"
      })).rejects.toMatchObject({ code: "publication_item_path_missing" });

      const current = await createPostgresReadyDocumentPublicationItem({
        transaction: database,
        knowledgeBaseId: "single-current-kb",
        mutationPublicId: "current-mutation",
        documentJobPublicId: null,
        sourceFilePublicId: "single-current-source",
        sourceRevisionPublicId: "single-current-revision",
        operation: "replace",
        affectedEvidence: {},
        createdAt: "2026-08-25T12:00:02.000Z"
      });
      const job = await repository.admitOne({
        now: "2026-08-25T12:00:04.000Z",
        rendererContractVersion: "portable-okf-v2"
      });
      expect(job?.knowledgeBaseId).toBe("single-current-kb");
      expect(job?.items.map((entry) => entry.publicId)).toEqual([
        current.publicId
      ]);
      await expect(sql<Array<{ outcome: string }>>`
        SELECT outcome FROM focowiki.publication_items
        WHERE public_id = 'obsolete-pending-item'
      `).resolves.toEqual([{ outcome: "superseded" }]);
    });

  it("admits another knowledge base while earlier jobs remain pending",
    async () => {
      await sql`
        INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
        VALUES ('single-fair-a', 'Fair A', 1), ('single-fair-b', 'Fair B', 1)
      `;
      const repository = createPostgresDocumentPublicationJobRepository(database);
      await repository.createItem({
        ...item(2_001),
        publicId: "fair-item-a",
        mutationPublicId: "fair-mutation-a",
        knowledgeBaseId: "single-fair-a",
        createdAt: "2026-08-25T13:00:00.000Z"
      });
      await repository.createItem({
        ...item(2_002),
        publicId: "fair-item-b",
        mutationPublicId: "fair-mutation-b",
        knowledgeBaseId: "single-fair-b",
        createdAt: "2026-08-25T13:00:00.100Z"
      });
      const first = await repository.admitOne({
        now: "2026-08-25T13:00:02.000Z",
        rendererContractVersion: "portable-okf-v2"
      });
      const second = await repository.admitOne({
        now: "2026-08-25T13:00:02.000Z",
        rendererContractVersion: "portable-okf-v2"
      });
      expect([first?.knowledgeBaseId, second?.knowledgeBaseId]).toEqual([
        "single-fair-a", "single-fair-b"
      ]);
      await sql`
        DELETE FROM focowiki.knowledge_bases
        WHERE public_id IN ('single-fair-a', 'single-fair-b')
      `;
    });

  it("releases a graceful shutdown attempt without consuming retry budget",
    async () => {
      await sql`
        INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
        VALUES ('single-release-kb', 'Release attempt', 1)
      `;
      const repository = createPostgresDocumentPublicationJobRepository(database);
      await repository.createItem({
        ...item(2_100),
        publicId: "single-release-item",
        mutationPublicId: "single-release-mutation",
        knowledgeBaseId: "single-release-kb",
        createdAt: "2026-08-25T13:30:00.000Z"
      });
      const job = await repository.admitOne({
        now: "2026-08-25T13:30:02.000Z",
        rendererContractVersion: "portable-okf-v2"
      });
      await sql`
        UPDATE focowiki.publication_jobs
        SET next_eligible_at = '2100-01-01T00:00:00.000Z'
        WHERE outcome = 'pending' AND public_id <> ${job!.publicId}
      `;
      const claimed = await repository.claimOne({
        workerId: "worker-release-a",
        now: "2026-08-25T13:30:03.000Z"
      });
      expect(claimed?.publicId).toBe(job?.publicId);
      await expect(repository.releaseAttempt({
        jobPublicId: claimed!.publicId,
        attemptToken: claimed!.attemptToken!,
        releasedAt: "2026-08-25T13:30:04.000Z"
      })).resolves.toBe(true);
      await expect(repository.readJob(claimed!.publicId)).resolves.toMatchObject({
        attemptCount: 0,
        attemptOwner: null,
        attemptToken: null,
        attemptDeadline: null
      });
      await expect(repository.claimOne({
        workerId: "worker-release-b",
        now: "2026-08-25T13:30:04.001Z"
      })).resolves.toMatchObject({
        publicId: claimed!.publicId,
        attemptCount: 1
      });
    });

  it("reads relation deltas when no related projection row exists", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('single-delta-kb', 'Delta query', 1)
    `;
    await sql`
      INSERT INTO focowiki.publication_items (
        public_id, mutation_public_id, knowledge_base_id,
        source_file_public_id, source_revision_public_id, operation,
        prior_logical_path, next_logical_path, readiness_sequence
      ) VALUES (
        'single-delta-item', 'single-delta-mutation', 'single-delta-kb',
        'single-delta-source', 'single-delta-revision', 'create',
        NULL, 'delta.md', 1
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_jobs (
        public_id, knowledge_base_id, base_active_revision,
        target_readiness_sequence, renderer_contract_version
      ) VALUES (
        'single-delta-job', 'single-delta-kb', 0, 1, 'portable-okf-v2'
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_job_items (
        job_public_id, item_public_id, membership_order
      ) VALUES ('single-delta-job', 'single-delta-item', 0)
    `;

    await expect(readPublicationJobFactDeltas(
      database,
      "single-delta-job"
    )).resolves.toEqual([expect.objectContaining({
      sourceFilePublicId: "single-delta-source",
      relatedSourceFilePublicIds: []
    })]);
  });

  it("deduplicates delivery and excludes a deleted knowledge base", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('single-deleted-kb', 'Deleted candidate', 1)
    `;
    const repository = createPostgresDocumentPublicationJobRepository(database);
    const delivered = {
      ...item(3_001),
      publicId: "single-deleted-item",
      mutationPublicId: "single-deleted-mutation",
      knowledgeBaseId: "single-deleted-kb",
      createdAt: "2026-08-25T14:00:00.000Z"
    };
    const first = await repository.createItem(delivered);
    const duplicate = await repository.createItem(delivered);
    expect(duplicate).toEqual(first);
    await expect(sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count FROM focowiki.publication_items
      WHERE knowledge_base_id = 'single-deleted-kb'
    `).resolves.toEqual([{ count: "1" }]);
    await sql`
      UPDATE focowiki.knowledge_bases
      SET deleted_at = '2026-08-25T14:00:01.000Z'
      WHERE public_id = 'single-deleted-kb'
    `;
    await repository.admitOne({
      now: "2026-08-25T14:00:02.000Z",
      rendererContractVersion: "portable-okf-v2"
    });
    await expect(sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count FROM focowiki.publication_jobs
      WHERE knowledge_base_id = 'single-deleted-kb'
    `).resolves.toEqual([{ count: "0" }]);
  });

  async function seedCurrentRevision(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('single-current-kb', 'Current revision', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('single-current-kb', 0)
    `;
    for (const object of [
      { id: "single-current-old-object", checksum: "4".repeat(64) },
      { id: "single-current-object", checksum: "5".repeat(64) }
    ]) {
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at
        ) VALUES (
          ${object.id}, ${`objects/${object.id}`}, ${object.checksum}, 10,
          'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
          'verified', ${`${object.id}-attempt`},
          '2026-08-25T11:59:00.000Z'
        )
      `;
    }
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision
      ) VALUES (
        'single-current-source', 'single-current-kb', 'current.md',
        'current.md', 'Current', '{}'::jsonb, 2
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES
        ('single-current-old-revision', 'single-current-kb',
         'single-current-source', 'single-current-old-object',
         ${"4".repeat(64)}, 10, 'text/markdown; charset=utf-8'),
        ('single-current-revision', 'single-current-kb',
         'single-current-source', 'single-current-object',
         ${"5".repeat(64)}, 10, 'text/markdown; charset=utf-8')
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES (
        'single-current-kb', 'single-current-source',
        'single-current-revision', 'single-current-old-revision', 0
      )
    `;
    await sql`
      INSERT INTO focowiki.document_projection_records (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, summary, metadata, headings,
        entities, content_type, checksum_sha256, byte_count,
        tokenizer_contract_version, navigation_term_fingerprint_sha256,
        active
      ) VALUES
        ('single-current-kb', 'single-current-source',
         'single-current-old-revision', 'old.md', 'old.md', 'Old', 'Old',
         '{}'::jsonb, '{}'::text[], '{}'::text[],
         'text/markdown; charset=utf-8', ${"4".repeat(64)}, 10,
         'tokenizer-v1', ${"6".repeat(64)}, true),
        ('single-current-kb', 'single-current-source',
         'single-current-revision', 'current.md', 'current.md', 'Current',
         'Current', '{}'::jsonb, '{}'::text[], '{}'::text[],
         'text/markdown; charset=utf-8', ${"5".repeat(64)}, 10,
         'tokenizer-v1', ${"7".repeat(64)}, false)
    `;
  }

  async function readPendingHead(knowledgeBaseId: string) {
    const rows = await sql<Array<{
      pending_item_count: number | string;
      oldest_pending_at: Date | string | null;
      latest_pending_at: Date | string | null;
    }>>`
      SELECT pending_item_count, oldest_pending_at, latest_pending_at
      FROM focowiki.knowledge_base_publication_heads
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    return {
      ...rows[0],
      pending_item_count: String(rows[0]?.pending_item_count)
    };
  }
});

function item(index: number) {
  const identity = String(index).padStart(3, "0");
  return {
    publicId: `publication-item-${identity}`,
    mutationPublicId: `mutation-${identity}`,
    knowledgeBaseId: "single-job-kb",
    documentJobPublicId: null,
    sourceFilePublicId: `source-${identity}`,
    sourceRevisionPublicId: `revision-${identity}`,
    operation: "create" as const,
    priorLogicalPath: null,
    nextLogicalPath: `documents/${identity}.md`,
    affectedEvidence: {
      runtimeSettingsRevisionPublicId: "settings-revision-1",
      generationModelConfigurationPublicId: "generation-model-1",
      generationModelConfigurationRevision: 2,
      embeddingConfigurationRevisionPublicId: "embedding-revision-1",
      semanticGenerationPublicId: "semantic-generation-1",
      semanticContractVersion: "semantic-contract-v1"
    },
    readinessSequence: index + 1,
    createdAt: "2026-08-25T10:00:00.000Z"
  };
}

function publicationOutput(input: Readonly<{
  normalizedPath: string;
  objectId: string;
  checksumSha256: string;
  byteCount: number;
  producerFingerprintSha256: string;
}>) {
  return {
    normalizedPath: input.normalizedPath,
    logicalPath: input.normalizedPath,
    action: "put" as const,
    entryKind: "source-page",
    sourceFilePublicId: null,
    sourceRevisionPublicId: null,
    objectId: input.objectId,
    checksumSha256: input.checksumSha256,
    byteCount: input.byteCount,
    contentType: "text/markdown; charset=utf-8",
    producerFingerprintSha256: input.producerFingerprintSha256,
    navigationMutations: []
  };
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
