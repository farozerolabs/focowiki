import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { normalizeDocumentPublicationScopeOutput } from
  "../src/document-indexing/application/document-publication-scope-output.js";
import {
  documentFactEpoch,
  documentPublicationGenerationId,
  documentScopeGeneration
} from "../src/document-indexing/domain/document-publication-identifiers.js";
import { createPostgresDocumentPublicationRepository } from
  "../src/document-indexing/infrastructure/postgres-document-publication-repository.js";
import { createPostgresDocumentPublicationRecovery } from
  "../src/document-indexing/infrastructure/postgres-document-publication-recovery.js";
import { createMinimumCompatiblePublicationReplacement } from
  "../src/document-indexing/infrastructure/postgres-document-publication-minimum-replan.js";
import {
  applyPostgresDocumentDirectoryNavigation,
  createPostgresDocumentDirectoryNavigation
} from
  "../src/document-indexing/infrastructure/postgres-document-directory-navigation.js";
import { createPostgresDocumentPublicationCoordinator } from
  "../src/document-indexing/infrastructure/postgres-document-publication-coordinator.js";
import { readBaseGraphDirectoryRecordKeys } from
  "../src/document-indexing/infrastructure/postgres-document-graph-directory-scope-reader.js";
import { createPostgresDocumentPerFileGraphDirectory } from
  "../src/document-indexing/infrastructure/postgres-document-per-file-graph-directory.js";
import { createPostgresDocumentPublicationValidator } from
  "../src/document-indexing/infrastructure/postgres-document-publication-validator.js";
import { createPostgresDocumentScopeGenerationRepository } from
  "../src/document-indexing/infrastructure/postgres-document-scope-generation-repository.js";
import { createPostgresProjectionPathOwnerRepository } from
  "../src/document-indexing/infrastructure/postgres-projection-path-owner-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document publication repositories", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_publication_repo_${
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
    await seed(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("allocates monotonic idempotent fact epochs under concurrency", async () => {
    const repository = createPostgresDocumentPublicationRepository(database);
    const allocated = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      repository.allocateFactEpoch({
        knowledgeBaseId: "publication-kb",
        mutationPublicId: `mutation-${index}`,
        sourceFilePublicId: `source-${index}`,
        sourceRevisionPublicId: `revision-${index}`,
        factKind: "create",
        createdAt: `2026-08-21T12:00:0${index}.000Z`
      })));
    expect([...allocated].sort((left, right) => left - right))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(repository.allocateFactEpoch({
      knowledgeBaseId: "publication-kb",
      mutationPublicId: "mutation-0",
      sourceFilePublicId: "source-0",
      sourceRevisionPublicId: "revision-0",
      factKind: "create",
      createdAt: "2026-08-21T12:01:00.000Z"
    })).resolves.toBe(1);
    await expect(repository.readHead("publication-kb")).resolves.toEqual({
      knowledgeBaseId: "publication-kb",
      activeGenerationId: null,
      activeFactEpoch: 0,
      headVersion: 0
    });
  });

  it("orders prior graph directory record keys by projected aliases", async () => {
    await expect(readBaseGraphDirectoryRecordKeys(database, {
      knowledgeBaseId: "publication-kb",
      scopePath: "pages",
      affectedSourceFilePublicIds: ["source-1"],
      baseDeterministicChangedAt: "2026-08-21T12:00:00.000Z"
    })).resolves.toEqual([]);
  });

  it("reads disconnected navigation neighborhoods as bounded windows",
    async () => {
      const letters = ["a", "b", "c", "d", "e", "f", "g"];
      const leaves = letters.map((letter, index) => ({
        id: `directory-leaf-${letter}`,
        previousLeafId: index > 0
          ? `directory-leaf-${letters[index - 1]}` : null,
        nextLeafId: index < letters.length - 1
          ? `directory-leaf-${letters[index + 1]}` : null,
        revision: 1,
        entries: [{
          id: `entry-${letter}`,
          sortKey: `1/${letter}.md/pages/disconnected/${letter}.md`,
          name: letter.toUpperCase(),
          targetPath: `pages/disconnected/${letter}.md`,
          kind: "file" as const
        }]
      }));
      await applyPostgresDocumentDirectoryNavigation({
        transaction: database,
        knowledgeBaseId: "publication-kb",
        activationRevision: 1,
        mutations: [{
          directoryPath: "pages/disconnected",
          touchedLeaves: leaves,
          removedLeafIds: []
        }],
        activatedAt: "2026-08-21T12:00:00.000Z"
      });
      const desiredEntries = ["b", "f"].map((letter) => ({
        id: `entry-${letter}`,
        sortKey: `1/${letter}.md/pages/disconnected/${letter}.md`,
        name: `${letter.toUpperCase()} updated`,
        targetPath: `pages/disconnected/${letter}.md`,
        kind: "file" as const
      }));

      const delta = await createPostgresDocumentDirectoryNavigation(database)
        .readDelta({
          knowledgeBaseId: "publication-kb",
          directoryPath: "pages/disconnected",
          desiredEntries,
          candidateEntryIds: desiredEntries.map((entry) => entry.id),
          maximumChanges: 16,
          maximumLeaves: 16,
          maximumEntries: 16
        });

      expect(delta.mode).toBe("windows");
      if (delta.mode !== "windows") throw new Error("Expected bounded windows");
      expect(delta.windows.map((window) => window.map((leaf) => leaf.id)))
        .toEqual([
          ["directory-leaf-a", "directory-leaf-b", "directory-leaf-c"],
          ["directory-leaf-e", "directory-leaf-f", "directory-leaf-g"]
        ]);
      expect(delta.changes.map((change) => change.entryId))
        .toEqual(["entry-b", "entry-f"]);
      expect(delta.totalEntryCount).toBe(7);
      expect(delta.firstLeafId).toBe("directory-leaf-a");
    });

  it("keeps descendant graph files out of root delta navigation", async () => {
    await sql.begin(async (transaction) => {
      await transaction`SET LOCAL session_replication_role = replica`;
      await transaction`
        INSERT INTO focowiki.document_projection_records (
          knowledge_base_id, source_file_public_id, source_revision_public_id,
          logical_path, normalized_path, title, summary, metadata, headings,
          entities, content_type, checksum_sha256, byte_count,
          tokenizer_contract_version, navigation_term_fingerprint_sha256,
          active
        ) VALUES (
          'publication-kb', 'navigation-root-source',
          'navigation-root-revision', 'guides/overview.md',
          'guides/overview.md', 'Overview', '', '{}'::jsonb, '{}'::text[],
          '{}'::text[], 'text/markdown; charset=utf-8', ${"e".repeat(64)},
          1, 'nodejieba-test-v1', ${"f".repeat(64)}, true
        )
      `;
      await transaction`
        INSERT INTO focowiki.document_semantic_directory_memberships (
          knowledge_base_id, source_revision_public_id, directory_path,
          page_path
        ) VALUES
          ('publication-kb', 'navigation-root-revision', 'pages',
            'pages/guides/overview.md'),
          ('publication-kb', 'navigation-root-revision', 'pages/guides',
            'pages/guides/overview.md')
      `;
      await transaction`
        INSERT INTO focowiki.document_graph_degrees (
          knowledge_base_id, source_revision_public_id,
          incoming_count, outgoing_count
        ) VALUES (
          'publication-kb', 'navigation-root-revision', 1, 0
        )
      `;
    });

    const reader = createPostgresDocumentPerFileGraphDirectory(database);
    await expect(reader.readPerFileGraphDirectoryDeltaState({
      knowledgeBaseId: "publication-kb",
      scopePath: "pages",
      publicationGenerationPublicId: "missing-generation",
      includedSourceRevisionPublicIds: ["navigation-root-revision"],
      affectedSourceFilePublicIds: ["navigation-root-source"],
      candidateChildScopePaths: ["pages/guides"]
    })).resolves.toEqual({
      records: [],
      childDirectories: [{
        title: "guides",
        scopePath: "pages/guides",
        path: "_graph/by-file/guides/index.md"
      }]
    });
  });

  it("enforces one candidate and newer-epoch ownership transfer", async () => {
    const publications = createPostgresDocumentPublicationRepository(database);
    const owners = createPostgresProjectionPathOwnerRepository(database);
    const firstId = documentPublicationGenerationId("generation-1");
    await publications.createGeneration(generation(firstId, null, 8));
    await expect(publications.createGeneration(generation(
      documentPublicationGenerationId("generation-conflict"),
      null,
      8
    ))).rejects.toMatchObject({ code: "23505" });
    await expect(publications.addDocuments({
      generationId: firstId,
      documents: [{
        mutationPublicId: "publication-job-1",
        documentJobPublicId: "publication-job-1",
        sourceFilePublicId: "source-1",
        sourceRevisionPublicId: "revision-1",
        factEpoch: documentFactEpoch(1)
      }]
    })).resolves.toBe(1);
    await sql`
      UPDATE focowiki.projection_publication_generations
      SET state = 'active', completed_at = now()
      WHERE public_id = ${firstId}
    `;
    const secondId = documentPublicationGenerationId("generation-2");
    await publications.createGeneration(generation(secondId, firstId, 8));
    await expect(owners.transferArtifacts({
      knowledgeBaseId: "publication-kb",
      generationId: firstId,
      ownershipEpoch: documentFactEpoch(1),
      owners: [{
        normalizedPath: "index.md",
        ownerScopeIdentity: "root:index",
        artifactFamily: "root"
      }],
      updatedAt: "2026-08-21T12:02:00.000Z"
    })).resolves.toBe(1);
    await expect(owners.transferArtifacts({
      knowledgeBaseId: "publication-kb",
      generationId: secondId,
      ownershipEpoch: documentFactEpoch(2),
      owners: [{
        normalizedPath: "index.md",
        ownerScopeIdentity: "root:index",
        artifactFamily: "root"
      }],
      updatedAt: "2026-08-21T12:03:00.000Z"
    })).resolves.toBe(1);
    await expect(owners.transferArtifacts({
      knowledgeBaseId: "publication-kb",
      generationId: firstId,
      ownershipEpoch: documentFactEpoch(1),
      owners: [{
        normalizedPath: "index.md",
        ownerScopeIdentity: "root:index",
        artifactFamily: "root"
      }],
      updatedAt: "2026-08-21T12:04:00.000Z"
    })).rejects.toMatchObject({ code: "projection_owner_epoch_stale" });
    await expect(owners.transferDirectories({
      knowledgeBaseId: "publication-kb",
      generationId: secondId,
      ownershipEpoch: documentFactEpoch(2),
      owners: [{ directoryPath: "_index", ownerScopeIdentity: "root:index" }],
      updatedAt: "2026-08-21T12:03:00.000Z"
    })).resolves.toBe(1);
    await sql`
      UPDATE focowiki.projection_publication_generations
      SET state = 'active', completed_at = now()
      WHERE public_id = ${secondId}
    `;
    const ninthEpoch = await publications.allocateFactEpoch({
      knowledgeBaseId: "publication-kb",
      mutationPublicId: "mutation-8",
      sourceFilePublicId: "source-8",
      sourceRevisionPublicId: "revision-8",
      factKind: "create",
      createdAt: "2026-08-21T12:04:00.000Z"
    });
    const thirdId = documentPublicationGenerationId("generation-3");
    await publications.createGeneration(generation(thirdId, secondId, ninthEpoch));
    const firstPage = await publications.listGenerations({
      knowledgeBaseId: "publication-kb",
      limit: 2,
      cursor: null
    });
    expect(firstPage.items.map((item) => item.publicId))
      .toEqual([thirdId, firstId]);
    expect(firstPage.nextCursor).not.toBeNull();
    await expect(publications.listGenerations({
      knowledgeBaseId: "publication-kb",
      limit: 2,
      cursor: firstPage.nextCursor
    })).resolves.toMatchObject({
      items: [expect.objectContaining({ publicId: secondId })],
      nextCursor: null
    });
    await publications.setRetention({
      generationId: firstId,
      state: "eligible",
      retainUntil: "2026-08-22T12:00:00.000Z",
      reason: "superseded-generation",
      updatedAt: "2026-08-21T12:05:00.000Z"
    });
    await expect(sql<Array<{ retention_state: string }>>`
      SELECT retention_state FROM focowiki.projection_generation_retention
      WHERE generation_public_id = ${firstId}
    `).resolves.toEqual([{ retention_state: "eligible" }]);
  });

  it("persists immutable scope input and fences concurrent output", async () => {
    const repository = createPostgresDocumentScopeGenerationRepository(database);
    await sql`
      UPDATE focowiki.projection_publication_generations
      SET state = 'quarantined'
      WHERE public_id = 'generation-3'
    `;
    await sql`
      UPDATE focowiki.projection_publication_generations
      SET state = 'rendering'
      WHERE public_id = 'generation-2'
    `;
    await repository.create({
      publicId: "scope-generation-1",
      publicationGenerationId: documentPublicationGenerationId("generation-2"),
      knowledgeBaseId: "publication-kb",
      scopeIdentity: "root:index",
      scopeKind: "root",
      scopeKey: "index",
      scopeGeneration: documentScopeGeneration(1),
      inputSnapshotFingerprintSha256: "a".repeat(64),
      createdAt: "2026-08-21T12:05:00.000Z"
    });
    await expect(repository.persistSnapshotMembers({
      scopeGenerationPublicId: "scope-generation-1",
      members: [{
        kind: "source_revision",
        publicId: "revision-1",
        version: "1",
        order: 0
      }]
    })).resolves.toBe(1);
    const claims = await Promise.all([
      repository.claim({
        workerId: "scope-worker-a", now: "2026-08-21T12:05:01.000Z",
        leaseDurationMs: 30_000, limit: 1
      }),
      repository.claim({
        workerId: "scope-worker-b", now: "2026-08-21T12:05:01.000Z",
        leaseDurationMs: 30_000, limit: 1
      })
    ]);
    const claim = claims.flat()[0]!;
    expect(claims.flat()).toHaveLength(1);
    const workerId = claims[0]!.length > 0
      ? "scope-worker-a" : "scope-worker-b";
    const pages = [{
      logicalPath: "index.md",
      normalizedPath: "index.md",
      action: "put" as const,
      entryKind: "root-index",
      objectId: generatedObjectId(),
      checksumSha256: "d".repeat(64),
      byteCount: 64
    }];
    const navigationMutations = [{
      directoryPath: "_index",
      order: 0,
      action: "upsert" as const,
      mutation: { schemaVersion: "navigation-v1" }
    }];
    const validationEvidence = {
      scopeIdentity: "root:index",
      sourceTargets: { checked: 1, missing: 0 },
      linkTargets: { checked: 1, missing: 0 },
      continuationChains: { checked: 1, broken: 0 },
      navigation: { expected: 1, actual: 1 },
      graph: { outgoing: 0, incoming: 0 },
      indexes: { expected: 1, actual: 1 },
      tombstones: { expected: 0, actual: 0 },
      search: { expected: 0, ready: 0 }
    };
    const outputFingerprintSha256 = normalizeDocumentPublicationScopeOutput({
      scope: { kind: "root", key: "index" },
      inputSnapshotFingerprintSha256: "a".repeat(64),
      rendererContractVersion: "portable-okf-v2",
      pages,
      navigationMutations,
      validationEvidence
    }).outputFingerprintSha256;
    await expect(repository.persistOutput({
      scopeGenerationPublicId: "scope-generation-1",
      workerId,
      leaseGeneration: claim.leaseGeneration,
      checkedAt: "2026-08-21T12:05:02.000Z",
      outputFingerprintSha256,
      validationEvidence,
      pages,
      navigationMutations,
      verifiedReservations: [{
        objectId: generatedObjectId(),
        writeAttemptPublicId: "publication-write"
      }]
    })).resolves.toBeUndefined();
    await expect(sql<Array<{
      object_id: string;
      write_attempt_public_id: string;
      state: string;
    }>>`
      SELECT object_id, write_attempt_public_id, state
      FROM focowiki.projection_cleanup_outbox
      WHERE scope_public_id = 'scope-generation-1'
    `).resolves.toEqual([{
      object_id: generatedObjectId(),
      write_attempt_public_id: "publication-write",
      state: "waiting"
    }]);
    await expect(repository.persistOutput({
      scopeGenerationPublicId: "scope-generation-1",
      workerId: "scope-worker-stale",
      leaseGeneration: claim.leaseGeneration,
      checkedAt: "2026-08-21T12:05:03.000Z",
      outputFingerprintSha256,
      validationEvidence: { linksChecked: 1 },
      pages: [],
      navigationMutations: [],
      verifiedReservations: []
    })).rejects.toMatchObject({ code: "scope_generation_lease_lost" });
    await expect(createPostgresDocumentPublicationValidator(database).validate({
      generationPublicId: "generation-2",
      checkedAt: "2026-08-21T12:05:04.000Z"
    })).resolves.toMatchObject({ state: "ready", failedChecks: [] });
    await sql`
      UPDATE focowiki.projection_publication_generations
      SET state = 'active', completed_at = '2026-08-21T12:05:05.000Z'
      WHERE public_id = 'generation-2'
    `;
    const publications = createPostgresDocumentPublicationRepository(database);
    await publications.createGeneration(generation(
      documentPublicationGenerationId("generation-4"),
      documentPublicationGenerationId("generation-2"),
      10
    ));
    await repository.create({
      publicId: "scope-generation-2",
      publicationGenerationId: documentPublicationGenerationId("generation-4"),
      knowledgeBaseId: "publication-kb",
      scopeIdentity: "root:index",
      scopeKind: "root",
      scopeKey: "index",
      scopeGeneration: documentScopeGeneration(2),
      inputSnapshotFingerprintSha256: "a".repeat(64),
      createdAt: "2026-08-21T12:05:06.000Z"
    });
    await sql`
      UPDATE focowiki.projection_publication_generations
      SET state = 'rendering'
      WHERE public_id = 'generation-4'
    `;
    await sql`
      DELETE FROM focowiki.projection_scope_generation_object_refs
      WHERE scope_generation_public_id = 'scope-generation-1'
    `;
    await expect(repository.reuseCompletedOutput({
      scopeGenerationPublicId: "scope-generation-2",
      checkedAt: "2026-08-21T12:05:07.000Z"
    })).resolves.toBe(true);
    await expect(sql<Array<{
      state: string;
      page_count: number | string;
      reference_count: number | string;
    }>>`
      SELECT scope.state,
             count(DISTINCT page.normalized_path) AS page_count,
             count(DISTINCT reference.object_id) AS reference_count
      FROM focowiki.projection_scope_generations scope
      LEFT JOIN focowiki.projection_scope_generation_pages page
        ON page.scope_generation_public_id = scope.public_id
      LEFT JOIN focowiki.projection_scope_generation_object_refs reference
        ON reference.scope_generation_public_id = scope.public_id
      WHERE scope.public_id = 'scope-generation-2'
      GROUP BY scope.state
    `).resolves.toEqual([{
      state: "completed",
      page_count: "1",
      reference_count: "1"
    }]);
    await sql`
      UPDATE focowiki.projection_scope_generations
      SET output_fingerprint_sha256 = ${"e".repeat(64)}
      WHERE public_id = 'scope-generation-2'
    `;
    await sql`
      UPDATE focowiki.projection_publication_generations
      SET state = 'active', completed_at = '2026-08-21T12:05:08.000Z'
      WHERE public_id = 'generation-4'
    `;
    await publications.createGeneration(generation(
      documentPublicationGenerationId("generation-5"),
      documentPublicationGenerationId("generation-4"),
      11
    ));
    await repository.create({
      publicId: "scope-generation-3",
      publicationGenerationId: documentPublicationGenerationId("generation-5"),
      knowledgeBaseId: "publication-kb",
      scopeIdentity: "root:index",
      scopeKind: "root",
      scopeKey: "index",
      scopeGeneration: documentScopeGeneration(3),
      inputSnapshotFingerprintSha256: "a".repeat(64),
      createdAt: "2026-08-21T12:05:09.000Z"
    });
    await sql`
      UPDATE focowiki.projection_publication_generations
      SET state = 'rendering'
      WHERE public_id = 'generation-5'
    `;
    await expect(repository.reuseCompletedOutput({
      scopeGenerationPublicId: "scope-generation-3",
      checkedAt: "2026-08-21T12:05:10.000Z"
    })).rejects.toMatchObject({ code: "scope_generation_output_diverged" });
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.projection_publication_generations
      WHERE public_id = 'generation-5'
    `).resolves.toEqual([{ state: "quarantined" }]);
    await expect(sql<Array<{ invariant_code: string }>>`
      SELECT invariant_code FROM focowiki.projection_invariant_diagnostics
      WHERE generation_public_id = 'generation-5'
    `).resolves.toEqual([{
      invariant_code: "same_snapshot_output_mismatch"
    }]);
  });

  it("renews and recovers publication scope leases with generation fencing",
    async () => {
      const publications = createPostgresDocumentPublicationRepository(database);
      const generationId = documentPublicationGenerationId("generation-6");
      await publications.createGeneration(generation(
        generationId,
        documentPublicationGenerationId("generation-4"),
        12
      ));
      await sql`
        INSERT INTO focowiki.projection_fact_epochs (
          knowledge_base_id, fact_epoch, mutation_public_id,
          source_file_public_id, source_revision_public_id, fact_kind, state
        ) VALUES (
          'publication-kb', 12, 'lease-recompute-mutation',
          'source-1', 'revision-1', 'replace', 'included'
        )
      `;
      await sql`
        INSERT INTO focowiki.projection_generation_documents (
          generation_public_id, mutation_public_id, document_job_public_id,
          source_file_public_id, source_revision_public_id, fact_epoch
        ) VALUES (
          ${generationId}, 'lease-recompute-mutation', NULL,
          'source-1', 'revision-1', 12
        )
      `;
      const repository = createPostgresDocumentScopeGenerationRepository(database);
      await repository.create({
        publicId: "scope-generation-lease",
        publicationGenerationId: generationId,
        knowledgeBaseId: "publication-kb",
        scopeIdentity: "source:source-1",
        scopeKind: "source",
        scopeKey: "source-1",
        scopeGeneration: documentScopeGeneration(4),
        inputSnapshotFingerprintSha256: "9".repeat(64),
        createdAt: "2026-08-21T12:06:00.000Z"
      });
      const claim = (await repository.claim({
        workerId: "scope-worker-current",
        now: "2026-08-21T12:06:01.000Z",
        leaseDurationMs: 1_000,
        limit: 1
      }))[0]!;
      await expect(repository.heartbeat({
        publicId: claim.publicId,
        workerId: "scope-worker-current",
        leaseGeneration: claim.leaseGeneration,
        now: "2026-08-21T12:06:01.500Z",
        leaseDurationMs: 1_000
      })).resolves.toBe(true);
      await expect(repository.heartbeat({
        publicId: claim.publicId,
        workerId: "scope-worker-stale",
        leaseGeneration: claim.leaseGeneration,
        now: "2026-08-21T12:06:01.600Z",
        leaseDurationMs: 1_000
      })).resolves.toBe(false);
      await expect(repository.recoverExpired({
        now: "2026-08-21T12:06:03.000Z",
        limit: 10
      })).resolves.toBe(1);
      const reclaimed = (await repository.claim({
        workerId: "scope-worker-next",
        now: "2026-08-21T12:06:03.100Z",
        leaseDurationMs: 1_000,
        limit: 1
      }))[0]!;
      expect(reclaimed.leaseGeneration).toBeGreaterThan(claim.leaseGeneration);
      await expect(repository.fail({
        publicId: reclaimed.publicId,
        workerId: "scope-worker-next",
        leaseGeneration: reclaimed.leaseGeneration,
        now: "2026-08-21T12:06:03.200Z",
        errorCode: "provider_transient",
        recoveryAction: "retry_provider"
      })).resolves.toBe("waiting");

      const recomputeClaim = (await repository.claim({
        workerId: "scope-worker-recompute",
        now: "2026-08-21T12:06:03.300Z",
        leaseDurationMs: 1_000,
        limit: 1
      }))[0]!;
      await expect(repository.fail({
        publicId: recomputeClaim.publicId,
        workerId: "scope-worker-recompute",
        leaseGeneration: recomputeClaim.leaseGeneration,
        now: "2026-08-21T12:06:03.400Z",
        errorCode: "publication_generation_stale_base",
        recoveryAction: "recompute_scope"
      })).resolves.toBe("superseded");
      await expect(sql<Array<{ generation_state: string; scope_state: string }>>`
        SELECT generation.state AS generation_state, scope.state AS scope_state
        FROM focowiki.projection_publication_generations generation
        JOIN focowiki.projection_scope_generations scope
          ON scope.publication_generation_public_id = generation.public_id
        WHERE generation.public_id = 'generation-6'
      `).resolves.toEqual([{
        generation_state: "obsolete",
        scope_state: "superseded"
      }]);
      const replacements = await sql<Array<{ public_id: string }>>`
        SELECT public_id FROM focowiki.projection_publication_generations
        WHERE recovery_evidence->>'supersedesGenerationPublicId'
          = ${generationId}
      `;
      expect(replacements).toHaveLength(1);
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'obsolete', completed_at = now()
        WHERE public_id = ${replacements[0]!.public_id}
      `;

      const quarantineGenerationId = documentPublicationGenerationId(
        "generation-7"
      );
      await publications.createGeneration(generation(
        quarantineGenerationId,
        documentPublicationGenerationId("generation-4"),
        13
      ));
      await repository.create({
        publicId: "scope-generation-quarantine",
        publicationGenerationId: quarantineGenerationId,
        knowledgeBaseId: "publication-kb",
        scopeIdentity: "source:source-2",
        scopeKind: "source",
        scopeKey: "source-2",
        scopeGeneration: documentScopeGeneration(5),
        inputSnapshotFingerprintSha256: "8".repeat(64),
        createdAt: "2026-08-21T12:06:04.000Z"
      });
      await repository.create({
        publicId: "scope-generation-quarantine-dependent",
        publicationGenerationId: quarantineGenerationId,
        knowledgeBaseId: "publication-kb",
        scopeIdentity: "root:index-quarantine",
        scopeKind: "root",
        scopeKey: "index",
        scopeGeneration: documentScopeGeneration(5),
        inputSnapshotFingerprintSha256: "9".repeat(64),
        createdAt: "2026-08-21T12:06:04.001Z"
      });
      const quarantineClaim = (await repository.claim({
        workerId: "scope-worker-quarantine",
        now: "2026-08-21T12:06:04.100Z",
        leaseDurationMs: 1_000,
        limit: 1
      }))[0]!;
      await expect(repository.fail({
        publicId: quarantineClaim.publicId,
        workerId: "scope-worker-quarantine",
        leaseGeneration: quarantineClaim.leaseGeneration,
        now: "2026-08-21T12:06:04.200Z",
        errorCode: "projection_scope_page_conflict",
        recoveryAction: "quarantine"
      })).resolves.toBe("quarantined");
      await expect(sql<Array<{
        generation_state: string;
        scope_state: string;
        invariant_code: string;
      }>>`
        SELECT generation.state AS generation_state, scope.state AS scope_state,
               diagnostic.invariant_code
        FROM focowiki.projection_publication_generations generation
        JOIN focowiki.projection_scope_generations scope
          ON scope.publication_generation_public_id = generation.public_id
        JOIN focowiki.projection_invariant_diagnostics diagnostic
          ON diagnostic.generation_public_id = generation.public_id
        WHERE generation.public_id = 'generation-7'
        ORDER BY scope.public_id
      `).resolves.toEqual([{
        generation_state: "quarantined",
        scope_state: "quarantined",
        invariant_code: "projection_scope_page_conflict"
      }, {
        generation_state: "quarantined",
        scope_state: "superseded",
        invariant_code: "projection_scope_page_conflict"
      }]);
    });

  it("recovers remediated publication quarantines in bounded batches",
    async () => {
      const publications = createPostgresDocumentPublicationRepository(database);
      const generationId = documentPublicationGenerationId("generation-8");
      await publications.createGeneration(generation(
        generationId,
        documentPublicationGenerationId("generation-4"),
        14
      ));
      await sql`
        INSERT INTO focowiki.projection_fact_epochs (
          knowledge_base_id, fact_epoch, mutation_public_id,
          source_file_public_id, source_revision_public_id, fact_kind, state
        ) VALUES (
          'publication-kb', 14, 'publication-recovery-mutation',
          'source-1', 'revision-1', 'replace', 'included'
        )
      `;
      await sql`
        INSERT INTO focowiki.projection_generation_documents (
          generation_public_id, mutation_public_id, document_job_public_id,
          source_file_public_id, source_revision_public_id, fact_epoch
        ) VALUES (
          ${generationId}, 'publication-recovery-mutation',
          'publication-job-1', 'source-1', 'revision-1', 14
        )
      `;
      const scopes = createPostgresDocumentScopeGenerationRepository(database);
      for (const [suffix, kind, key] of [
        ["graph", "_graph", "directory:pages/library"],
        ["root", "root", "index"]
      ] as const) {
        await scopes.create({
          publicId: `scope-generation-recovery-${suffix}`,
          publicationGenerationId: generationId,
          knowledgeBaseId: "publication-kb",
          scopeIdentity: `${kind}:${key}`,
          scopeKind: kind,
          scopeKey: key,
          scopeGeneration: documentScopeGeneration(6),
          inputSnapshotFingerprintSha256: suffix === "graph"
            ? "a".repeat(64) : "b".repeat(64),
          createdAt: "2026-08-21T12:07:00.000Z"
        });
      }
      await sql`
        UPDATE focowiki.projection_scope_generations
        SET state = CASE WHEN scope_kind = '_graph'
          THEN 'quarantined' ELSE 'waiting' END
        WHERE publication_generation_public_id = ${generationId}
      `;
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'quarantined',
            safe_error_code = 'per_file_graph_directory_limit_exceeded'
        WHERE public_id = ${generationId}
      `;
      const recovery = createPostgresDocumentPublicationRecovery(database);
      await expect(recovery.recoverRecoverableQuarantines({
        recoveredAt: "2026-08-21T12:07:01.000Z",
        limit: 1
      })).resolves.toEqual({
        generationCount: 1,
        releasedFactCount: 1,
        supersededScopeCount: 2
      });
      await expect(sql<Array<{
        generation_state: string;
        safe_error_code: string;
        fact_state: string;
        waiting_scope_count: number | string;
      }>>`
        SELECT generation.state AS generation_state,
               generation.safe_error_code,
               epoch.state AS fact_state,
               count(scope.public_id) FILTER (
                 WHERE scope.state = 'waiting'
               ) AS waiting_scope_count
        FROM focowiki.projection_publication_generations generation
        JOIN focowiki.projection_generation_documents document
          ON document.generation_public_id = generation.public_id
        JOIN focowiki.projection_fact_epochs epoch
          ON epoch.knowledge_base_id = generation.knowledge_base_id
         AND epoch.mutation_public_id = document.mutation_public_id
         AND epoch.fact_epoch = document.fact_epoch
        JOIN focowiki.projection_scope_generations scope
          ON scope.publication_generation_public_id = generation.public_id
        WHERE generation.public_id = ${generationId}
        GROUP BY generation.state, generation.safe_error_code, epoch.state
      `).resolves.toEqual([{
        generation_state: "obsolete",
        safe_error_code: "graph_directory_record_limit_remediated",
        fact_state: "ready",
        waiting_scope_count: "0"
      }]);
      await sql`
        UPDATE focowiki.projection_fact_epochs
        SET state = 'included'
        WHERE knowledge_base_id = 'publication-kb'
          AND fact_epoch = 14
      `;
      await sql`
        UPDATE focowiki.projection_scope_generations
        SET state = CASE WHEN scope_kind = '_graph'
          THEN 'quarantined' ELSE 'waiting' END
        WHERE publication_generation_public_id = ${generationId}
      `;
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'quarantined', safe_error_code = '53100',
            completed_at = NULL
        WHERE public_id = ${generationId}
      `;
      await expect(recovery.recoverRecoverableQuarantines({
        recoveredAt: "2026-08-21T12:07:02.000Z",
        limit: 1
      })).resolves.toEqual({
        generationCount: 1,
        releasedFactCount: 1,
        supersededScopeCount: 2
      });
      await sql`
        UPDATE focowiki.projection_fact_epochs
        SET state = 'included'
        WHERE knowledge_base_id = 'publication-kb'
          AND fact_epoch = 14
      `;
      await sql`
        UPDATE focowiki.projection_scope_generations
        SET state = CASE WHEN scope_kind = '_graph'
          THEN 'waiting' ELSE 'quarantined' END
        WHERE publication_generation_public_id = ${generationId}
      `;
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'quarantined',
            safe_error_code = 'navigation_delta_window_exceeded',
            completed_at = NULL
        WHERE public_id = ${generationId}
      `;
      await expect(recovery.recoverRecoverableQuarantines({
        recoveredAt: "2026-08-21T12:07:03.000Z",
        limit: 1
      })).resolves.toEqual({
        generationCount: 1,
        releasedFactCount: 1,
        supersededScopeCount: 2
      });
      await expect(sql<Array<{
        generation_state: string;
        safe_error_code: string;
        fact_state: string;
      }>>`
        SELECT generation.state AS generation_state,
               generation.safe_error_code, epoch.state AS fact_state
        FROM focowiki.projection_publication_generations generation
        JOIN focowiki.projection_generation_documents document
          ON document.generation_public_id = generation.public_id
        JOIN focowiki.projection_fact_epochs epoch
          ON epoch.knowledge_base_id = generation.knowledge_base_id
         AND epoch.mutation_public_id = document.mutation_public_id
         AND epoch.fact_epoch = document.fact_epoch
        WHERE generation.public_id = ${generationId}
      `).resolves.toEqual([{
        generation_state: "obsolete",
        safe_error_code: "navigation_delta_window_remediated",
        fact_state: "ready"
      }]);
      await sql`
        UPDATE focowiki.projection_fact_epochs
        SET state = 'included'
        WHERE knowledge_base_id = 'publication-kb'
          AND fact_epoch = 14
      `;
      await sql`
        UPDATE focowiki.projection_scope_generations
        SET state = CASE WHEN scope_kind = '_graph'
          THEN 'quarantined' ELSE 'waiting' END
        WHERE publication_generation_public_id = ${generationId}
      `;
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'quarantined',
            safe_error_code = 'scope_generation_deadline_exceeded',
            completed_at = NULL
        WHERE public_id = ${generationId}
      `;
      await expect(recovery.recoverRecoverableQuarantines({
        recoveredAt: "2026-08-21T12:07:04.000Z",
        limit: 1
      })).resolves.toEqual({
        generationCount: 1,
        releasedFactCount: 1,
        supersededScopeCount: 2
      });
      await expect(sql<Array<{
        generation_state: string;
        safe_error_code: string;
        fact_state: string;
      }>>`
        SELECT generation.state AS generation_state,
               generation.safe_error_code, epoch.state AS fact_state
        FROM focowiki.projection_publication_generations generation
        JOIN focowiki.projection_generation_documents document
          ON document.generation_public_id = generation.public_id
        JOIN focowiki.projection_fact_epochs epoch
          ON epoch.knowledge_base_id = generation.knowledge_base_id
         AND epoch.mutation_public_id = document.mutation_public_id
         AND epoch.fact_epoch = document.fact_epoch
        WHERE generation.public_id = ${generationId}
      `).resolves.toEqual([{
        generation_state: "obsolete",
        safe_error_code: "scope_generation_deadline_remediated",
        fact_state: "ready"
      }]);
      await sql`
        UPDATE focowiki.projection_fact_epochs
        SET state = 'included'
        WHERE knowledge_base_id = 'publication-kb'
          AND fact_epoch = 14
      `;
      await sql`
        UPDATE focowiki.projection_scope_generations
        SET state = CASE WHEN scope_kind = '_graph'
          THEN 'quarantined' ELSE 'waiting' END
        WHERE publication_generation_public_id = ${generationId}
      `;
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'quarantined',
            safe_error_code =
              'semantic_directory_navigation_candidate_limit_exceeded',
            completed_at = NULL
        WHERE public_id = ${generationId}
      `;
      await expect(recovery.recoverRecoverableQuarantines({
        recoveredAt: "2026-08-21T12:07:05.000Z",
        limit: 1
      })).resolves.toEqual({
        generationCount: 1,
        releasedFactCount: 1,
        supersededScopeCount: 2
      });
      await expect(sql<Array<{
        generation_state: string;
        safe_error_code: string;
        fact_state: string;
      }>>`
        SELECT generation.state AS generation_state,
               generation.safe_error_code, epoch.state AS fact_state
        FROM focowiki.projection_publication_generations generation
        JOIN focowiki.projection_generation_documents document
          ON document.generation_public_id = generation.public_id
        JOIN focowiki.projection_fact_epochs epoch
          ON epoch.knowledge_base_id = generation.knowledge_base_id
         AND epoch.mutation_public_id = document.mutation_public_id
         AND epoch.fact_epoch = document.fact_epoch
        WHERE generation.public_id = ${generationId}
      `).resolves.toEqual([{
        generation_state: "obsolete",
        safe_error_code: "semantic_directory_navigation_limit_remediated",
        fact_state: "ready"
      }]);
      await expect(recovery.recoverRecoverableQuarantines({
        recoveredAt: "2026-08-21T12:07:06.000Z",
        limit: 1
      })).resolves.toEqual({
        generationCount: 0,
        releasedFactCount: 0,
        supersededScopeCount: 0
      });
      await expect(sql<Array<{ state: string }>>`
        SELECT state
        FROM focowiki.projection_publication_generations
        WHERE public_id = 'generation-7'
      `).resolves.toEqual([{ state: "quarantined" }]);
    });

  it("recovers legacy navigation capacity quarantines for large directories",
    async () => {
      const generationId = documentPublicationGenerationId(
        "generation-navigation-capacity"
      );
      const publications = createPostgresDocumentPublicationRepository(database);
      await publications.createGeneration(generation(
        generationId,
        documentPublicationGenerationId("generation-4"),
        16
      ));
      await sql`
        INSERT INTO focowiki.projection_fact_epochs (
          knowledge_base_id, fact_epoch, mutation_public_id,
          source_file_public_id, source_revision_public_id, fact_kind, state
        ) VALUES (
          'publication-kb', 16, 'navigation-capacity-mutation',
          'source-1', 'revision-1', 'replace', 'included'
        )
      `;
      await sql`
        INSERT INTO focowiki.projection_generation_documents (
          generation_public_id, mutation_public_id, document_job_public_id,
          source_file_public_id, source_revision_public_id, fact_epoch
        ) VALUES (
          ${generationId}, 'navigation-capacity-mutation',
          'publication-job-1', 'source-1', 'revision-1', 16
        )
      `;
      const scopes = createPostgresDocumentScopeGenerationRepository(database);
      await scopes.create({
        publicId: "scope-generation-navigation-capacity",
        publicationGenerationId: generationId,
        knowledgeBaseId: "publication-kb",
        scopeIdentity: "directory:pages/large",
        scopeKind: "directory",
        scopeKey: "pages/large",
        scopeGeneration: documentScopeGeneration(7),
        inputSnapshotFingerprintSha256: "c".repeat(64),
        createdAt: "2026-08-21T12:08:00.000Z"
      });
      await sql.begin(async (transaction) => {
        await transaction`SET LOCAL session_replication_role = replica`;
        await transaction`
          INSERT INTO focowiki.document_projection_records (
            knowledge_base_id, source_file_public_id, source_revision_public_id,
            logical_path, normalized_path, title, summary, metadata, headings,
            entities, content_type, checksum_sha256, byte_count,
            tokenizer_contract_version, navigation_term_fingerprint_sha256,
            active
          )
          SELECT 'publication-kb', 'capacity-source-' || value,
                 'capacity-revision-' || value,
                 'large/file-' || lpad(value::text, 5, '0') || '.md',
                 'large/file-' || lpad(value::text, 5, '0') || '.md',
                 'Capacity file ' || value, '', '{}'::jsonb, '{}'::text[],
                 '{}'::text[], 'text/markdown; charset=utf-8', ${"e".repeat(64)},
                 1, 'nodejieba-test-v1', ${"f".repeat(64)}, true
          FROM generate_series(1, 10001) value
        `;
        await transaction`
          INSERT INTO focowiki.document_semantic_directory_memberships (
            knowledge_base_id, source_revision_public_id, directory_path,
            page_path
          )
          SELECT 'publication-kb', 'capacity-revision-' || value,
                 'pages/large',
                 'pages/large/file-' || lpad(value::text, 5, '0') || '.md'
          FROM generate_series(1, 10001) value
        `;
      });
      await sql`
        UPDATE focowiki.projection_scope_generations
        SET state = 'quarantined'
        WHERE publication_generation_public_id = ${generationId}
      `;
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'quarantined', safe_error_code = 'changes_invalid'
        WHERE public_id = ${generationId}
      `;

      const recovery = createPostgresDocumentPublicationRecovery(database);
      await expect(recovery.recoverRecoverableQuarantines({
        recoveredAt: "2026-08-21T12:08:01.000Z",
        limit: 1
      })).resolves.toEqual({
        generationCount: 1,
        releasedFactCount: 1,
        supersededScopeCount: 1
      });
      await expect(sql<Array<{
        generation_state: string;
        safe_error_code: string;
        fact_state: string;
      }>>`
        SELECT generation.state AS generation_state,
               generation.safe_error_code, epoch.state AS fact_state
        FROM focowiki.projection_publication_generations generation
        JOIN focowiki.projection_generation_documents document
          ON document.generation_public_id = generation.public_id
        JOIN focowiki.projection_fact_epochs epoch
          ON epoch.knowledge_base_id = generation.knowledge_base_id
         AND epoch.mutation_public_id = document.mutation_public_id
         AND epoch.fact_epoch = document.fact_epoch
        WHERE generation.public_id = ${generationId}
      `).resolves.toEqual([{
        generation_state: "obsolete",
        safe_error_code: "navigation_change_limit_remediated",
        fact_state: "ready"
      }]);
      await sql`
        UPDATE focowiki.projection_scope_generations
        SET state = 'quarantined'
        WHERE publication_generation_public_id = ${generationId}
      `;
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'quarantined',
            safe_error_code = 'navigation_changes_invalid'
        WHERE public_id = ${generationId}
      `;
      await sql`
        UPDATE focowiki.projection_fact_epochs
        SET state = 'included'
        WHERE knowledge_base_id = 'publication-kb'
          AND fact_epoch = 16
      `;
      await expect(recovery.recoverRecoverableQuarantines({
        recoveredAt: "2026-08-21T12:08:02.000Z",
        limit: 1
      })).resolves.toEqual({
        generationCount: 0,
        releasedFactCount: 0,
        supersededScopeCount: 0
      });
      await sql`
        DELETE FROM focowiki.document_projection_records
        WHERE knowledge_base_id = 'publication-kb'
          AND source_file_public_id LIKE 'capacity-source-%'
      `;
    }, 120_000);

  it("backs off database resource exhaustion and releases an expired generation",
    async () => {
      const publications = createPostgresDocumentPublicationRepository(database);
      const generationId = documentPublicationGenerationId("generation-resource");
      await publications.createGeneration(generation(
        generationId,
        documentPublicationGenerationId("generation-4"),
        15
      ));
      await sql`
        INSERT INTO focowiki.projection_fact_epochs (
          knowledge_base_id, fact_epoch, mutation_public_id,
          source_file_public_id, source_revision_public_id, fact_kind, state
        ) VALUES (
          'publication-kb', 15, 'resource-recompute-mutation',
          'source-1', 'revision-1', 'replace', 'included'
        )
      `;
      await sql`
        INSERT INTO focowiki.projection_generation_documents (
          generation_public_id, mutation_public_id, document_job_public_id,
          source_file_public_id, source_revision_public_id, fact_epoch
        ) VALUES (
          ${generationId}, 'resource-recompute-mutation', NULL,
          'source-1', 'revision-1', 15
        )
      `;
      const scopes = createPostgresDocumentScopeGenerationRepository(database);
      await scopes.create({
        publicId: "scope-generation-resource",
        publicationGenerationId: generationId,
        knowledgeBaseId: "publication-kb",
        scopeIdentity: "source:resource",
        scopeKind: "source",
        scopeKey: "resource",
        scopeGeneration: documentScopeGeneration(7),
        inputSnapshotFingerprintSha256: "c".repeat(64),
        createdAt: "2026-08-21T12:08:00.000Z"
      });
      const firstClaim = (await scopes.claim({
        workerId: "scope-worker-resource",
        now: "2026-08-21T12:08:01.000Z",
        leaseDurationMs: 1_000,
        limit: 1
      }))[0]!;
      await expect(scopes.fail({
        publicId: firstClaim.publicId,
        workerId: "scope-worker-resource",
        leaseGeneration: firstClaim.leaseGeneration,
        now: "2026-08-21T12:08:01.100Z",
        errorCode: "53100",
        recoveryAction: "retry_infrastructure"
      })).resolves.toBe("waiting");
      await expect(sql<Array<{
        state: string;
        resource_failure_count: number;
        retry_delayed: boolean;
      }>>`
        SELECT state, resource_failure_count,
               next_eligible_at > '2026-08-21T12:08:01.100Z'::timestamptz
                 AS retry_delayed
        FROM focowiki.projection_scope_generations
        WHERE public_id = 'scope-generation-resource'
      `).resolves.toEqual([{
        state: "waiting",
        resource_failure_count: 1,
        retry_delayed: true
      }]);
      await sql`
        UPDATE focowiki.projection_scope_generations
        SET resource_failure_started_at = '2026-08-21T11:38:00.000Z',
            next_eligible_at = '2026-08-21T12:08:02.000Z'
        WHERE public_id = 'scope-generation-resource'
      `;
      const expiredClaim = (await scopes.claim({
        workerId: "scope-worker-resource-expired",
        now: "2026-08-21T12:08:02.000Z",
        leaseDurationMs: 1_000,
        limit: 1
      }))[0]!;
      await expect(scopes.fail({
        publicId: expiredClaim.publicId,
        workerId: "scope-worker-resource-expired",
        leaseGeneration: expiredClaim.leaseGeneration,
        now: "2026-08-21T12:08:02.100Z",
        errorCode: "53100",
        recoveryAction: "retry_infrastructure"
      })).resolves.toBe("superseded");
      await expect(sql<Array<{ state: string; safe_error_code: string }>>`
        SELECT state, safe_error_code
        FROM focowiki.projection_publication_generations
        WHERE public_id = ${generationId}
      `).resolves.toEqual([{
        state: "obsolete",
        safe_error_code: "53100"
      }]);
      const replacements = await sql<Array<{ public_id: string }>>`
        SELECT public_id FROM focowiki.projection_publication_generations
        WHERE recovery_evidence->>'supersedesGenerationPublicId'
          = ${generationId}
      `;
      expect(replacements).toHaveLength(1);
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'obsolete', completed_at = now()
        WHERE public_id = ${replacements[0]!.public_id}
      `;
    });

  it("supersedes incompatible projection only and preserves upstream work",
    async () => {
      const publications = createPostgresDocumentPublicationRepository(database);
      const generationId = documentPublicationGenerationId(
        "generation-incompatible"
      );
      await publications.createGeneration(generation(
        generationId,
        documentPublicationGenerationId("generation-4"),
        17
      ));
      await sql`
        INSERT INTO focowiki.projection_fact_epochs (
          knowledge_base_id, fact_epoch, mutation_public_id,
          source_file_public_id, source_revision_public_id, fact_kind, state
        ) VALUES (
          'publication-kb', 17, 'incompatible-mutation',
          'source-1', 'revision-1', 'replace', 'included'
        )
      `;
      await sql`
        INSERT INTO focowiki.projection_generation_documents (
          generation_public_id, mutation_public_id, document_job_public_id,
          source_file_public_id, source_revision_public_id, fact_epoch
        ) VALUES (
          ${generationId}, 'incompatible-mutation', 'publication-job-1',
          'source-1', 'revision-1', 17
        )
      `;
      const scopes = createPostgresDocumentScopeGenerationRepository(database);
      await scopes.create({
        publicId: "scope-generation-incompatible",
        publicationGenerationId: generationId,
        knowledgeBaseId: "publication-kb",
        scopeIdentity: "root:index",
        scopeKind: "root",
        scopeKey: "index",
        scopeGeneration: documentScopeGeneration(8),
        inputSnapshotFingerprintSha256: "7".repeat(64),
        createdAt: "2026-08-21T12:09:00.000Z"
      });
      await sql`
        UPDATE focowiki.knowledge_base_projection_heads
        SET active_generation_public_id = 'generation-4',
            active_fact_epoch = 10
        WHERE knowledge_base_id = 'publication-kb'
      `;
      const upstreamBefore = await upstreamWorkCounts(sql);
      const recovery = createPostgresDocumentPublicationRecovery(database);

      await expect(recovery.recoverIncompatibleGenerations({
        rendererContractVersion: "portable-okf-v3",
        recoveredAt: "2026-08-21T12:09:01.000Z",
        limit: 10
      })).resolves.toEqual({
        generationCount: 1,
        releasedFactCount: 0,
        replannedFactCount: 1,
        supersededScopeCount: 1
      });

      await expect(sql<Array<{
        generation_state: string;
        scope_state: string;
        fact_state: string;
        active_generation_public_id: string | null;
        retention_state: string;
      }>>`
        SELECT generation.state AS generation_state,
               scope.state AS scope_state, epoch.state AS fact_state,
               head.active_generation_public_id,
               retention.retention_state
        FROM focowiki.projection_publication_generations generation
        JOIN focowiki.projection_scope_generations scope
          ON scope.publication_generation_public_id = generation.public_id
        JOIN focowiki.projection_generation_documents document
          ON document.generation_public_id = generation.public_id
        JOIN focowiki.projection_fact_epochs epoch
          ON epoch.knowledge_base_id = generation.knowledge_base_id
         AND epoch.mutation_public_id = document.mutation_public_id
         AND epoch.fact_epoch = document.fact_epoch
        JOIN focowiki.knowledge_base_projection_heads head
          ON head.knowledge_base_id = generation.knowledge_base_id
        JOIN focowiki.projection_generation_retention retention
          ON retention.generation_public_id = generation.public_id
        WHERE generation.public_id = ${generationId}
      `).resolves.toEqual([{
        generation_state: "obsolete",
        scope_state: "superseded",
        fact_state: "included",
        active_generation_public_id: "generation-4",
        retention_state: "retained"
      }]);
      await expect(upstreamWorkCounts(sql)).resolves.toEqual(upstreamBefore);
      const replacements = await sql<Array<{
        public_id: string;
        renderer_contract_version: string;
        state: string;
      }>>`
        SELECT public_id, renderer_contract_version, state
        FROM focowiki.projection_publication_generations
        WHERE recovery_evidence->>'supersedesGenerationPublicId'
          = ${generationId}
      `;
      expect(replacements).toEqual([expect.objectContaining({
        renderer_contract_version: "portable-okf-v3",
        state: "planned"
      })]);
      await expect(createPostgresDocumentPublicationCoordinator(database)
        .claimStrandedPlan({
          knowledgeBaseId: "publication-kb",
          now: "2026-08-21T12:09:01.001Z",
          staleAfterMs: 30_000
        })).resolves.toMatchObject({
          generationPublicId: replacements[0]!.public_id,
          rendererContractVersion: "portable-okf-v3",
          documents: [expect.objectContaining({
            mutationPublicId: "incompatible-mutation",
            sourceRevisionPublicId: "revision-1"
          })]
        });
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'obsolete', completed_at = now()
        WHERE public_id = ${replacements[0]!.public_id}
      `;
    });

  it("supersedes after the second unchanged lease loss and fences late writers",
    async () => {
      const publications = createPostgresDocumentPublicationRepository(database);
      const generationId = documentPublicationGenerationId(
        "generation-two-losses"
      );
      await publications.createGeneration(generation(
        generationId,
        documentPublicationGenerationId("generation-4"),
        18
      ));
      await sql`
        INSERT INTO focowiki.projection_fact_epochs (
          knowledge_base_id, fact_epoch, mutation_public_id,
          source_file_public_id, source_revision_public_id, fact_kind, state
        ) VALUES (
          'publication-kb', 18, 'two-loss-mutation',
          'source-1', 'revision-1', 'replace', 'included'
        )
      `;
      await sql`
        INSERT INTO focowiki.projection_generation_documents (
          generation_public_id, mutation_public_id, document_job_public_id,
          source_file_public_id, source_revision_public_id, fact_epoch
        ) VALUES (
          ${generationId}, 'two-loss-mutation', 'publication-job-1',
          'source-1', 'revision-1', 18
        )
      `;
      const scopes = createPostgresDocumentScopeGenerationRepository(database);
      await scopes.create({
        publicId: "scope-generation-two-losses",
        publicationGenerationId: generationId,
        knowledgeBaseId: "publication-kb",
        scopeIdentity: "root:index",
        scopeKind: "root",
        scopeKey: "index",
        scopeGeneration: documentScopeGeneration(9),
        inputSnapshotFingerprintSha256: "6".repeat(64),
        createdAt: "2026-08-21T12:10:00.000Z"
      });
      const first = (await scopes.claim({
        workerId: "scope-worker-loss-one",
        now: "2026-08-21T12:10:01.000Z",
        leaseDurationMs: 1_000,
        limit: 1
      }))[0]!;
      await expect(scopes.recoverExpired({
        now: "2026-08-21T12:10:03.000Z", limit: 1
      })).resolves.toBe(1);
      const second = (await scopes.claim({
        workerId: "scope-worker-loss-two",
        now: "2026-08-21T12:10:03.100Z",
        leaseDurationMs: 1_000,
        limit: 1
      }))[0]!;
      expect(second.leaseGeneration).toBeGreaterThan(first.leaseGeneration);
      await expect(scopes.recoverExpired({
        now: "2026-08-21T12:10:05.000Z", limit: 1
      })).resolves.toBe(1);
      await expect(scopes.heartbeat({
        publicId: second.publicId,
        workerId: "scope-worker-loss-two",
        leaseGeneration: second.leaseGeneration,
        now: "2026-08-21T12:10:05.100Z",
        leaseDurationMs: 1_000
      })).resolves.toBe(false);
      await expect(sql<Array<{
        generation_state: string;
        scope_state: string;
        fact_state: string;
        consecutive_lease_loss_count: number;
        retention_state: string;
      }>>`
        SELECT generation.state AS generation_state,
               scope.state AS scope_state, epoch.state AS fact_state,
               scope.consecutive_lease_loss_count,
               retention.retention_state
        FROM focowiki.projection_publication_generations generation
        JOIN focowiki.projection_scope_generations scope
          ON scope.publication_generation_public_id = generation.public_id
        JOIN focowiki.projection_generation_documents document
          ON document.generation_public_id = generation.public_id
        JOIN focowiki.projection_fact_epochs epoch
          ON epoch.knowledge_base_id = generation.knowledge_base_id
         AND epoch.mutation_public_id = document.mutation_public_id
         AND epoch.fact_epoch = document.fact_epoch
        JOIN focowiki.projection_generation_retention retention
          ON retention.generation_public_id = generation.public_id
        WHERE generation.public_id = ${generationId}
      `).resolves.toEqual([{
        generation_state: "obsolete",
        scope_state: "superseded",
        fact_state: "included",
        consecutive_lease_loss_count: 2,
        retention_state: "retained"
      }]);
      const [firstReplacement] = await sql<Array<{ public_id: string }>>`
        SELECT public_id
        FROM focowiki.projection_publication_generations
        WHERE recovery_evidence->>'supersedesGenerationPublicId'
          = ${generationId}
      `;
      expect(firstReplacement).toBeDefined();
      const secondReplacement = await createMinimumCompatiblePublicationReplacement(
        database,
        {
          generationPublicId: firstReplacement!.public_id,
          rendererContractVersion: "portable-okf-v2",
          supersessionReason: "scope_generation_lease_lost",
          recoveredAt: "2026-08-21T12:10:06.000Z"
        }
      );
      expect(secondReplacement?.replacementGenerationPublicId)
        .not.toBe(firstReplacement!.public_id);
      await expect(sql<Array<{ state: string }>>`
        SELECT state
        FROM focowiki.projection_publication_generations
        WHERE public_id = ${secondReplacement!.replacementGenerationPublicId}
      `).resolves.toEqual([{ state: "planned" }]);
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'obsolete', completed_at = now()
        WHERE public_id = ${secondReplacement!.replacementGenerationPublicId}
      `;
      const recovery = createPostgresDocumentPublicationRecovery(database);
      await expect(recovery.recoverStrandedReplacements({
        rendererContractVersion: "portable-okf-v2",
        recoveredAt: "2026-08-21T12:10:07.000Z",
        limit: 10
      })).resolves.toMatchObject({
        generationCount: 1,
        replannedFactCount: 1
      });
      const liveReplacement = await sql<Array<{ public_id: string }>>`
        SELECT public_id
        FROM focowiki.projection_publication_generations
        WHERE knowledge_base_id = 'publication-kb'
          AND state = 'planned'
      `;
      expect(liveReplacement).toHaveLength(1);
      expect(liveReplacement[0]!.public_id).not.toBe(
        secondReplacement!.replacementGenerationPublicId
      );
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'quarantined', safe_error_code = '53100',
            completed_at = now()
        WHERE public_id = ${liveReplacement[0]!.public_id}
      `;
      await expect(recovery.recoverStrandedReplacements({
        rendererContractVersion: "portable-okf-v2",
        recoveredAt: "2026-08-21T12:10:08.000Z",
        limit: 10
      })).resolves.toMatchObject({
        generationCount: 1,
        replannedFactCount: 1
      });
      const recoveredReplacement = await sql<Array<{ public_id: string }>>`
        SELECT public_id
        FROM focowiki.projection_publication_generations
        WHERE knowledge_base_id = 'publication-kb'
          AND state = 'planned'
      `;
      expect(recoveredReplacement).toHaveLength(1);
      expect(recoveredReplacement[0]!.public_id)
        .not.toBe(liveReplacement[0]!.public_id);
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'obsolete', completed_at = now()
        WHERE public_id = ${recoveredReplacement[0]!.public_id}
      `;
    });

  it("does not recover an obsolete replacement covered by the active head",
    async () => {
      const publications = createPostgresDocumentPublicationRepository(database);
      const staleGenerationId = documentPublicationGenerationId(
        "generation-covered-replacement"
      );
      await publications.createGeneration(generation(
        staleGenerationId,
        documentPublicationGenerationId("generation-4"),
        19
      ));
      await sql`
        INSERT INTO focowiki.projection_fact_epochs (
          knowledge_base_id, fact_epoch, mutation_public_id,
          source_file_public_id, source_revision_public_id, fact_kind, state
        ) VALUES (
          'publication-kb', 19, 'covered-replacement-mutation',
          'source-1', 'revision-1', 'replace', 'included'
        )
      `;
      await sql`
        INSERT INTO focowiki.projection_generation_documents (
          generation_public_id, mutation_public_id, document_job_public_id,
          source_file_public_id, source_revision_public_id, fact_epoch
        ) VALUES (
          ${staleGenerationId}, 'covered-replacement-mutation',
          'publication-job-1', 'source-1', 'revision-1', 19
        )
      `;
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'obsolete', completed_at = '2026-08-21T12:11:00.000Z',
            updated_at = '2026-08-21T12:11:00.000Z',
            recovery_evidence = jsonb_build_object(
              'outcome', 'minimum_replacement_planned'
            )
        WHERE public_id = ${staleGenerationId}
      `;
      const activeGenerationId = documentPublicationGenerationId(
        "generation-covering-head"
      );
      await publications.createGeneration(generation(
        activeGenerationId,
        documentPublicationGenerationId("generation-4"),
        19
      ));
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'active', completed_at = '2026-08-21T12:11:01.000Z',
            updated_at = '2026-08-21T12:11:01.000Z'
        WHERE public_id = ${activeGenerationId}
      `;
      await sql`
        UPDATE focowiki.knowledge_base_projection_heads
        SET active_generation_public_id = ${activeGenerationId},
            active_fact_epoch = 19, head_version = head_version + 1,
            updated_at = '2026-08-21T12:11:01.000Z'
        WHERE knowledge_base_id = 'publication-kb'
      `;

      const recovery = createPostgresDocumentPublicationRecovery(database);
      await expect(recovery.recoverStrandedReplacements({
        rendererContractVersion: "portable-okf-v2",
        recoveredAt: "2026-08-21T12:11:02.000Z",
        limit: 10
      })).resolves.toEqual({
        generationCount: 0,
        releasedFactCount: 0,
        replannedFactCount: 0,
        supersededScopeCount: 0
      });
      await expect(sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.projection_publication_generations
        WHERE recovery_evidence->>'supersedesGenerationPublicId'
          = ${staleGenerationId}
      `).resolves.toEqual([{ count: "0" }]);
    });

  it("recovers an uncovered replacement when no active head exists",
    async () => {
      const publications = createPostgresDocumentPublicationRepository(database);
      const strandedGenerationId = documentPublicationGenerationId(
        "generation-without-active-head"
      );
      await publications.createGeneration(generation(
        strandedGenerationId,
        null,
        20
      ));
      await sql`
        INSERT INTO focowiki.projection_fact_epochs (
          knowledge_base_id, fact_epoch, mutation_public_id,
          source_file_public_id, source_revision_public_id, fact_kind, state
        ) VALUES (
          'publication-kb', 20, 'no-head-replacement-mutation',
          'source-1', 'revision-1', 'replace', 'included'
        )
      `;
      await sql`
        INSERT INTO focowiki.projection_generation_documents (
          generation_public_id, mutation_public_id, document_job_public_id,
          source_file_public_id, source_revision_public_id, fact_epoch
        ) VALUES (
          ${strandedGenerationId}, 'no-head-replacement-mutation',
          'publication-job-1', 'source-1', 'revision-1', 20
        )
      `;
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET state = 'obsolete', completed_at = '2026-08-21T12:12:00.000Z',
            updated_at = '2026-08-21T12:12:00.000Z',
            recovery_evidence = jsonb_build_object(
              'outcome', 'minimum_replacement_planned'
            )
        WHERE public_id = ${strandedGenerationId}
      `;
      await sql`
        UPDATE focowiki.knowledge_base_projection_heads
        SET active_generation_public_id = NULL, active_fact_epoch = 0,
            head_version = head_version + 1,
            updated_at = '2026-08-21T12:12:00.000Z'
        WHERE knowledge_base_id = 'publication-kb'
      `;

      const recovery = createPostgresDocumentPublicationRecovery(database);
      await expect(recovery.recoverStrandedReplacements({
        rendererContractVersion: "portable-okf-v2",
        recoveredAt: "2026-08-21T12:12:01.000Z",
        limit: 10
      })).resolves.toMatchObject({
        generationCount: 1,
        replannedFactCount: 1
      });
    });
});

function generation(
  publicId: ReturnType<typeof documentPublicationGenerationId>,
  baseGenerationId: ReturnType<typeof documentPublicationGenerationId> | null,
  targetFactEpoch: number
) {
  return {
    publicId,
    knowledgeBaseId: "publication-kb",
    baseGenerationId,
    targetFactEpoch,
    rendererContractVersion: "portable-okf-v2",
    deterministicChangedAt: "2026-08-21T12:02:00.000Z",
    inputFingerprintSha256: publicId.endsWith("1")
      ? "1".repeat(64) : "2".repeat(64)
  };
}

async function seed(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
    VALUES ('publication-kb', 'Publication', 1)
  `;
  await sql.begin(async (transaction) => {
    await transaction`SET LOCAL session_replication_role = replica`;
    await transaction`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES (
        'publication-operation', 'publication-kb', 'source_upload',
        'completed', 'source_file', 'source-1', now()
      )
    `;
    await transaction`
      INSERT INTO focowiki.document_processing_jobs (
        public_id, knowledge_base_id, operation_public_id,
        source_file_public_id, source_revision_public_id,
        runtime_settings_revision_public_id,
        generation_model_configuration_public_id,
        generation_model_configuration_revision,
        embedding_configuration_revision_public_id,
        semantic_generation_public_id, semantic_contract_version,
        state, maximum_attempts, accepted_at, started_at, terminal_at
      ) VALUES (
        'publication-job-1', 'publication-kb', 'publication-operation',
        'source-1', 'revision-1', 'settings', 'model', 1, 'embedding',
        'semantic', 'contract', 'available', 3, now(), now(), now()
      )
    `;
  });
  await sql`
    INSERT INTO focowiki.object_registrations (
      object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id, verified_at
    ) VALUES (
      ${generatedObjectId()}, 'generated/publication-index.md',
      ${"d".repeat(64)}, 64, 'text/markdown; charset=utf-8',
      'okf-generated-markdown-v1', 'verified', 'publication-write', now()
    )
  `;
}

function generatedObjectId(): string {
  return `generated-sha256:okf-generated-markdown-v1:${"d".repeat(64)}`;
}

async function upstreamWorkCounts(sql: postgres.Sql) {
  const rows = await sql<Array<{
    model_executions: number | string;
    graphrag_chunks: number | string;
    embedding_artifacts: number | string;
    artifact_work: number | string;
  }>>`
    SELECT
      (SELECT count(*) FROM focowiki.document_model_layer_executions)
        AS model_executions,
      (SELECT count(*) FROM focowiki.document_graphrag_chunks)
        AS graphrag_chunks,
      (SELECT count(*) FROM focowiki.embedding_artifacts)
        AS embedding_artifacts,
      (SELECT count(*) FROM focowiki.document_artifact_work)
        AS artifact_work
  `;
  const row = rows[0]!;
  return {
    modelExecutions: Number(row.model_executions),
    graphragChunks: Number(row.graphrag_chunks),
    embeddingArtifacts: Number(row.embedding_artifacts),
    artifactWork: Number(row.artifact_work)
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
