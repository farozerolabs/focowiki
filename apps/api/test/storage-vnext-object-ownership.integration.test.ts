import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";
import {
  createPostgresStorageVnextOwnershipRepository,
  purgePostgresStorageVnextDeletedRegistrations
} from "../src/storage-vnext/ownership/postgres-repository.js";
import {
  createStorageVnextFailedWriteCompensator,
  recoverStorageVnextStaleReservations
} from "../src/storage-vnext/ownership/failed-write-compensation.js";
import { createStorageVnextVersionAwareObjectDeletion } from
  "../src/storage-vnext/ownership/version-aware-deletion.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;
describeOwnedDatabase("storage vNext PostgreSQL object ownership", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_ownership_${ownerToken}_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const repository = createPostgresStorageVnextOwnershipRepository(sql, {
    zeroOwnerGraceMilliseconds: 86_400_000
  });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('kb-ownership', 'Ownership', 1)
    `;
    await sql`
      INSERT INTO focowiki.operations
        (public_id, knowledge_base_id, operation_kind, state)
      VALUES ('operation-write', 'kb-ownership', 'upload', 'accepted')
    `;
    await sql`
      INSERT INTO focowiki.release_roots
        (public_id, knowledge_base_id, root_role, manifest_checksum_sha256, revision)
      VALUES ('root-active', 'kb-ownership', 'active', ${"a".repeat(64)}, 1)
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

  it("does not count a reserved or verified registration as a live owner", async () => {
    const checksum = "b".repeat(64);
    const reserved = await repository.reserve({
      objectId: `generated-sha256:${checksum}`,
      storageKey: `owned/generated/sha256/${checksum.slice(0, 2)}/${checksum}.md`,
      checksum,
      byteCount: 12,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-attempt-1",
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    expect(reserved).toMatchObject({ outcome: "reserved", registration: { state: "reserved" } });
    await expect(repository.reserve({
      objectId: reserved.registration.objectId,
      storageKey: reserved.registration.storageKey,
      checksum,
      byteCount: 12,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-attempt-1",
      createdAt: "2026-08-01T00:00:00.000Z"
    })).resolves.toMatchObject({ outcome: "reserved" });
    await expect(repository.reserve({
      objectId: `generated-sha256:okf-generated-markdown-v1:${"d".repeat(64)}`,
      storageKey: `owned/generated/sha256/dd/${"d".repeat(64)}.md`,
      checksum: "d".repeat(64),
      byteCount: 12,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-attempt-1",
      createdAt: "2026-08-01T00:00:00.000Z"
    })).rejects.toMatchObject({ code: "write_attempt_conflict" });
    await expect(repository.getClosure(reserved.registration.objectId)).resolves.toMatchObject({
      ownerCount: 0,
      owners: []
    });

    await expect(repository.markVerified({
      objectId: reserved.registration.objectId,
      writeAttemptPublicId: "wrong-attempt",
      checksum,
      byteCount: 12,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      verifiedAt: "2026-08-01T00:01:00.000Z"
    })).rejects.toMatchObject({ code: "write_attempt_conflict" });

    await repository.markVerified({
      objectId: reserved.registration.objectId,
      writeAttemptPublicId: "write-attempt-1",
      checksum,
      byteCount: 12,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      verifiedAt: "2026-08-01T00:01:00.000Z"
    });
    const registration = await repository.getRegistration(reserved.registration.objectId);
    expect(registration).toMatchObject({ state: "verified", zeroOwnerSince: expect.any(String) });
    await expect(repository.reserve({
      objectId: reserved.registration.objectId,
      storageKey: reserved.registration.storageKey,
      checksum,
      byteCount: 12,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-attempt-replay",
      createdAt: "2026-08-01T00:02:00.000Z"
    })).resolves.toMatchObject({ outcome: "reused", registration: { state: "verified" } });
    await expect(repository.getClosure(reserved.registration.objectId)).resolves.toMatchObject({
      ownerCount: 0,
      owners: []
    });

    const eligible = await repository.listZeroOwnerObjects({
      graceElapsedBefore: "2026-08-03T00:00:00.000Z",
      limit: 10,
      cursor: null
    });
    expect(eligible.items.map((item) => item.objectId)).toEqual([
      reserved.registration.objectId
    ]);
  });

  it("rejects active-root ownership until the exact object is verified", async () => {
    const checksum = "c".repeat(64);
    const reserved = await repository.reserve({
      objectId: `generated-sha256:${checksum}`,
      storageKey: `owned/generated/sha256/${checksum.slice(0, 2)}/${checksum}.md`,
      checksum,
      byteCount: 24,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-attempt-2",
      createdAt: "2026-08-01T01:00:00.000Z"
    });
    const owner = {
      publicId: "owner-active-1",
      knowledgeBaseId: "kb-ownership",
      objectId: reserved.registration.objectId,
      kind: "active_root" as const,
      ownerPublicId: "root-active",
      createdAt: "2026-08-01T01:01:00.000Z"
    };

    await expect(repository.attach(owner)).rejects.toMatchObject({
      code: "object_unverified"
    });
    await repository.markVerified({
      objectId: reserved.registration.objectId,
      writeAttemptPublicId: "write-attempt-2",
      checksum,
      byteCount: 24,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      verifiedAt: "2026-08-01T01:02:00.000Z"
    });
    await sql`
      INSERT INTO focowiki.release_catalog_entries
        (knowledge_base_id, release_root_public_id, logical_path, entry_kind,
         checksum_sha256, object_id, byte_count, ordinal)
      VALUES ('kb-ownership', 'root-active', 'verified.md', 'index', ${checksum},
        ${reserved.registration.objectId}, 24, 0)
    `;
    await expect(repository.attach(owner)).resolves.toBeUndefined();
    await expect(repository.attach(owner)).resolves.toBeUndefined();
    await expect(repository.getClosure(reserved.registration.objectId)).resolves.toMatchObject({
      ownerCount: 1,
      owners: [{ kind: "active_root", ownerPublicId: "root-active" }],
      graceExpiresAt: null
    });

    await repository.release({
      objectId: reserved.registration.objectId,
      ownerPublicId: "root-active",
      kind: "active_root"
    });
    await expect(repository.getClosure(reserved.registration.objectId)).resolves.toMatchObject({
      ownerCount: 0,
      owners: []
    });
  });

  it("purges an ownerless registration only after provider-confirmed deletion", async () => {
    const checksum = "9".repeat(64);
    const reservation = await repository.reserve({
      objectId: "object-purge-deleted",
      storageKey: "owned/generated/purge-deleted.md",
      checksum,
      byteCount: 18,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-purge-deleted",
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    await repository.markVerified({
      objectId: reservation.registration.objectId,
      writeAttemptPublicId: reservation.registration.writeAttemptPublicId,
      checksum,
      byteCount: 18,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      verifiedAt: "2026-08-01T00:01:00.000Z"
    });
    const deletion = createStorageVnextVersionAwareObjectDeletion({
      registrations: repository,
      provider: {
        purge: vi.fn(async () => ({
          deletedVersions: 1,
          deletedMarkers: 0,
          abortedMultipartUploads: 0
        }))
      }
    });

    await deletion.deleteZeroOwner(reservation.registration.objectId);
    await expect(repository.getRegistration(reservation.registration.objectId))
      .resolves.toMatchObject({ state: "deleted" });
    await expect(purgePostgresStorageVnextDeletedRegistrations(sql, { limit: 10 }))
      .resolves.toBeGreaterThanOrEqual(1);
    await expect(repository.getRegistration(reservation.registration.objectId))
      .resolves.toBeNull();
  });

  it("reclaims a deleted content-addressed registration for an identical object", async () => {
    const checksum = "7".repeat(64);
    const descriptor = {
      objectId: "object-republish-deleted",
      storageKey: "owned/generated/republish-deleted.md",
      checksum,
      byteCount: 19,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1"
    };
    const reservation = await repository.reserve({
      ...descriptor,
      writeAttemptPublicId: "write-republish-deleted-a",
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    await repository.markVerified({
      ...descriptor,
      writeAttemptPublicId: reservation.registration.writeAttemptPublicId,
      verifiedAt: "2026-08-01T00:01:00.000Z"
    });
    const deletion = createStorageVnextVersionAwareObjectDeletion({
      registrations: repository,
      provider: {
        purge: vi.fn(async () => ({
          deletedVersions: 1,
          deletedMarkers: 0,
          abortedMultipartUploads: 0
        }))
      }
    });
    await deletion.deleteZeroOwner(descriptor.objectId);
    await expect(repository.getRegistration(descriptor.objectId)).resolves.toMatchObject({
      state: "deleted"
    });

    await expect(repository.reserve({
      ...descriptor,
      writeAttemptPublicId: "write-republish-deleted-b",
      createdAt: "2026-08-01T00:02:00.000Z"
    })).resolves.toMatchObject({
      outcome: "reserved",
      registration: {
        state: "reserved",
        writeAttemptPublicId: "write-republish-deleted-b",
        verifiedAt: null,
        zeroOwnerSince: null
      }
    });
  });

  it("blocks physical deletion while a durable source revision still references it", async () => {
    const checksum = "8".repeat(64);
    const reservation = await repository.reserve({
      objectId: "object-purge-source-reference",
      storageKey: "owned/source/purge-source-reference.md",
      checksum,
      byteCount: 21,
      contentType: "text/markdown; charset=utf-8",
      format: "source-markdown-v1",
      writeAttemptPublicId: "write-purge-source-reference",
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    await repository.markVerified({
      objectId: reservation.registration.objectId,
      writeAttemptPublicId: reservation.registration.writeAttemptPublicId,
      checksum,
      byteCount: 21,
      contentType: "text/markdown; charset=utf-8",
      format: "source-markdown-v1",
      verifiedAt: "2026-08-01T00:01:00.000Z"
    });
    await sql`
      INSERT INTO focowiki.source_files
        (public_id, knowledge_base_id, logical_path, normalized_path, title, status, revision)
      VALUES (
        'file-purge-source-reference', 'kb-ownership',
        'purge-source-reference.md', 'purge-source-reference.md',
        'Purge source reference', 'ready', 1
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions
        (public_id, knowledge_base_id, source_file_public_id, object_id,
         checksum_sha256, byte_count, content_type, revision_role)
      VALUES (
        'revision-purge-source-reference', 'kb-ownership',
        'file-purge-source-reference', ${reservation.registration.objectId},
        ${checksum}, 21, 'text/markdown; charset=utf-8', 'current'
      )
    `;
    const purge = vi.fn(async () => ({
      deletedVersions: 1,
      deletedMarkers: 0,
      abortedMultipartUploads: 0
    }));
    const deletion = createStorageVnextVersionAwareObjectDeletion({
      registrations: repository,
      provider: { purge }
    });

    await expect(deletion.deleteZeroOwner(reservation.registration.objectId))
      .rejects.toMatchObject({ code: "owners_present" });
    expect(purge).not.toHaveBeenCalled();
    await expect(purgePostgresStorageVnextDeletedRegistrations(sql, { limit: 10 }))
      .resolves.toBeGreaterThanOrEqual(0);
    await expect(repository.getRegistration(reservation.registration.objectId))
      .resolves.toMatchObject({ state: "verified" });

    await sql`
      DELETE FROM focowiki.source_files
      WHERE public_id = 'file-purge-source-reference'
    `;
    await expect(deletion.deleteZeroOwner(reservation.registration.objectId))
      .resolves.toMatchObject({ deletedVersions: 1 });
    await expect(purgePostgresStorageVnextDeletedRegistrations(sql, { limit: 10 }))
      .resolves.toBeGreaterThanOrEqual(1);
    await expect(repository.getRegistration(reservation.registration.objectId))
      .resolves.toBeNull();
  });

  it("attaches only exact source, root, shard, and live-operation owner targets", async () => {
    const verified = async (suffix: string) => {
      const checksum = suffix.repeat(64);
      const reservation = await repository.reserve({
        objectId: `object-owner-${suffix}`,
        storageKey: `owned/owner-${suffix}.md`,
        checksum,
        byteCount: 16,
        contentType: "text/markdown; charset=utf-8",
        format: "okf-generated-markdown-v1",
        writeAttemptPublicId: `write-owner-${suffix}`,
        createdAt: "2026-08-01T02:00:00.000Z"
      });
      await repository.markVerified({
        objectId: reservation.registration.objectId,
        writeAttemptPublicId: reservation.registration.writeAttemptPublicId,
        checksum,
        byteCount: 16,
        contentType: "text/markdown; charset=utf-8",
        format: "okf-generated-markdown-v1",
        verifiedAt: "2026-08-01T02:01:00.000Z"
      });
      return { objectId: reservation.registration.objectId, checksum };
    };
    const sourceObject = await verified("e");
    const activeObject = await verified("f");
    const candidateObject = await verified("1");
    const rollbackObject = await verified("2");
    const shardObject = await verified("3");
    const unreferencedObject = await verified("4");

    await sql`
      INSERT INTO focowiki.source_files
        (public_id, knowledge_base_id, logical_path, normalized_path, title, status, revision)
      VALUES ('file-owner', 'kb-ownership', 'Owner.md', 'owner.md', 'Owner', 'ready', 1)
    `;
    await sql`
      INSERT INTO focowiki.source_revisions
        (public_id, knowledge_base_id, source_file_public_id, object_id,
         checksum_sha256, byte_count, content_type, revision_role, expires_at)
      VALUES ('revision-owner', 'kb-ownership', 'file-owner', ${sourceObject.objectId},
        ${sourceObject.checksum}, 16, 'text/markdown; charset=utf-8', 'candidate',
        '2026-08-03T00:00:00.000Z')
    `;
    await sql`
      INSERT INTO focowiki.release_roots
        (public_id, knowledge_base_id, root_role, manifest_checksum_sha256, revision, expires_at)
      VALUES
        ('root-candidate-owner', 'kb-ownership', 'candidate', NULL, 2, NULL),
        ('root-rollback-owner', 'kb-ownership', 'rollback', ${"5".repeat(64)}, 0,
          '2026-08-02T00:00:00.000Z')
    `;
    await sql`
      INSERT INTO focowiki.release_catalog_entries
        (knowledge_base_id, release_root_public_id, logical_path, entry_kind,
         checksum_sha256, object_id, byte_count, ordinal)
      VALUES
        ('kb-ownership', 'root-active', 'active.md', 'index', ${activeObject.checksum},
          ${activeObject.objectId}, 16, 1),
        ('kb-ownership', 'root-candidate-owner', 'candidate.md', 'index',
          ${candidateObject.checksum}, ${candidateObject.objectId}, 16, 0),
        ('kb-ownership', 'root-rollback-owner', 'rollback.md', 'index',
          ${rollbackObject.checksum}, ${rollbackObject.objectId}, 16, 0)
    `;
    await sql`
      INSERT INTO focowiki.release_shards
        (public_id, knowledge_base_id, logical_kind, first_logical_path,
         last_logical_path, record_count, byte_count, checksum_sha256, object_id)
      VALUES ('shard-owner', 'kb-ownership', 'generated-markdown', 'a.md', 'z.md',
        1, 16, ${shardObject.checksum}, ${shardObject.objectId})
    `;

    const owners = [
      ["owner-source", sourceObject.objectId, "source_revision", "revision-owner"],
      ["owner-active", activeObject.objectId, "active_root", "root-active"],
      ["owner-candidate", candidateObject.objectId, "candidate_root", "root-candidate-owner"],
      ["owner-rollback", rollbackObject.objectId, "rollback_root", "root-rollback-owner"],
      ["owner-shard", shardObject.objectId, "shared_segment", "shard-owner"]
    ] as const;
    for (const [publicId, objectId, kind, ownerPublicId] of owners) {
      await repository.attach({
        publicId,
        knowledgeBaseId: "kb-ownership",
        objectId,
        kind,
        ownerPublicId,
        createdAt: "2026-08-01T02:02:00.000Z"
      });
      await expect(repository.getClosure(objectId)).resolves.toMatchObject({
        ownerCount: 1,
        referenceCount: 2,
        owners: [{ kind, ownerPublicId }],
        graceExpiresAt: null
      });
    }

    const live = await repository.reserve({
      objectId: "object-owner-live",
      storageKey: "owned/owner-live.md",
      checksum: "6".repeat(64),
      byteCount: 16,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-owner-live",
      createdAt: "2026-08-01T02:03:00.000Z"
    });
    await repository.attach({
      publicId: "owner-live",
      knowledgeBaseId: "kb-ownership",
      objectId: live.registration.objectId,
      kind: "live_reservation",
      ownerPublicId: "operation-write",
      createdAt: "2026-08-01T02:04:00.000Z"
    });
    await expect(repository.getClosure(live.registration.objectId)).resolves.toMatchObject({
      ownerCount: 1,
      owners: [{ kind: "live_reservation", ownerPublicId: "operation-write" }]
    });

    await expect(repository.attach({
      publicId: "owner-unreferenced-active",
      knowledgeBaseId: "kb-ownership",
      objectId: unreferencedObject.objectId,
      kind: "active_root",
      ownerPublicId: "root-active",
      createdAt: "2026-08-01T02:05:00.000Z"
    })).rejects.toMatchObject({ code: "owner_target_conflict" });

    for (const [, objectId, kind, ownerPublicId] of owners) {
      await repository.release({ objectId, kind, ownerPublicId });
      await expect(repository.getClosure(objectId)).resolves.toMatchObject({
        ownerCount: 0,
        referenceCount: 1,
        owners: [],
        graceExpiresAt: null
      });
    }
    await repository.release({
      objectId: live.registration.objectId,
      kind: "live_reservation",
      ownerPublicId: "operation-write"
    });
    await expect(repository.getClosure(live.registration.objectId)).resolves.toMatchObject({
      ownerCount: 0,
      owners: []
    });
  });

  it("recovers only unowned stale reservations after process termination", async () => {
    const stale = await repository.reserve({
      objectId: "object-stale-write",
      storageKey: "owned/stale-write.md",
      checksum: "7".repeat(64),
      byteCount: 8,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-stale",
      createdAt: "2026-07-30T00:00:00.000Z"
    });
    await repository.reserve({
      objectId: "object-fresh-write",
      storageKey: "owned/fresh-write.md",
      checksum: "8".repeat(64),
      byteCount: 8,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-fresh",
      createdAt: "2026-08-02T00:00:00.000Z"
    });
    const abortMultipartUploads = vi.fn(async () => undefined);
    const deleteCurrentObject = vi.fn(async () => undefined);
    const compensation = createStorageVnextFailedWriteCompensator({
      registrations: repository,
      provider: { abortMultipartUploads, deleteCurrentObject }
    });

    await expect(recoverStorageVnextStaleReservations({
      registrations: repository,
      compensation,
      staleBefore: "2026-07-31T00:00:00.000Z",
      failedAt: "2026-08-03T00:00:00.000Z",
      limit: 10,
      cursor: null
    })).resolves.toEqual({ processed: 1, nextCursor: null });
    expect(abortMultipartUploads).toHaveBeenCalledWith(stale.registration.storageKey);
    expect(deleteCurrentObject).toHaveBeenCalledWith(stale.registration.storageKey);
    await expect(repository.getRegistration(stale.registration.objectId)).resolves.toBeNull();
    await expect(repository.getRegistration("object-fresh-write")).resolves.toMatchObject({
      state: "reserved"
    });
  });

  it("lists registrations in bounded keyset pages and enforces one registration per storage key", async () => {
    const first = await repository.reserve({
      objectId: "object-inventory-a",
      storageKey: "owned/inventory/a.md",
      checksum: "9".repeat(64),
      byteCount: 1,
      contentType: "text/markdown; charset=utf-8",
      format: "source-markdown-v1",
      writeAttemptPublicId: "write-inventory-a",
      createdAt: "2026-08-03T00:00:00.000Z"
    });
    const second = await repository.reserve({
      objectId: "object-inventory-b",
      storageKey: "owned/inventory/b.md",
      checksum: "a".repeat(64),
      byteCount: 1,
      contentType: "text/markdown; charset=utf-8",
      format: "source-markdown-v1",
      writeAttemptPublicId: "write-inventory-b",
      createdAt: "2026-08-03T00:00:00.000Z"
    });
    await expect(repository.getRegistrationsByStorageKeys([
      second.registration.storageKey,
      first.registration.storageKey
    ])).resolves.toEqual([first.registration, second.registration]);
    await expect(repository.reserve({
      objectId: "object-inventory-key-conflict",
      storageKey: first.registration.storageKey,
      checksum: "b".repeat(64),
      byteCount: 2,
      contentType: "text/markdown; charset=utf-8",
      format: "source-markdown-v1",
      writeAttemptPublicId: "write-inventory-conflict",
      createdAt: "2026-08-03T00:00:00.000Z"
    })).rejects.toMatchObject({ code: "registration_conflict" });

    const objectIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await repository.listRegistrations({ limit: 3, cursor });
      objectIds.push(...page.items.map((item) => item.objectId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(objectIds).toContain(first.registration.objectId);
    expect(objectIds).toContain(second.registration.objectId);
    expect(new Set(objectIds).size).toBe(objectIds.length);
  });

  it("blocks physical deletion for a live root owner and marks deleted only after release", async () => {
    const checksum = "d".repeat(64);
    const reserved = await repository.reserve({
      objectId: "object-delete-guard",
      storageKey: "owned/delete-guard.md",
      checksum,
      byteCount: 5,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-delete-guard",
      createdAt: "2026-08-03T01:00:00.000Z"
    });
    await repository.markVerified({
      objectId: reserved.registration.objectId,
      writeAttemptPublicId: reserved.registration.writeAttemptPublicId,
      checksum,
      byteCount: 5,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      verifiedAt: "2026-08-03T01:01:00.000Z"
    });
    await sql`
      INSERT INTO focowiki.release_catalog_entries
        (knowledge_base_id, release_root_public_id, logical_path, entry_kind,
         checksum_sha256, object_id, byte_count, ordinal)
      VALUES ('kb-ownership', 'root-active', 'delete-guard.md', 'index', ${checksum},
        ${reserved.registration.objectId}, 5, 2)
    `;
    await repository.attach({
      publicId: "owner-delete-guard",
      knowledgeBaseId: "kb-ownership",
      objectId: reserved.registration.objectId,
      kind: "active_root",
      ownerPublicId: "root-active",
      createdAt: "2026-08-03T01:02:00.000Z"
    });
    const purge = vi.fn(async () => ({
      deletedVersions: 1,
      deletedMarkers: 0,
      abortedMultipartUploads: 0
    }));
    const deletion = createStorageVnextVersionAwareObjectDeletion({
      registrations: repository,
      provider: { purge }
    });

    await expect(deletion.deleteZeroOwner(reserved.registration.objectId))
      .rejects.toMatchObject({ code: "owners_present" });
    expect(purge).not.toHaveBeenCalled();
    await repository.release({
      objectId: reserved.registration.objectId,
      kind: "active_root",
      ownerPublicId: "root-active"
    });
    await expect(deletion.deleteZeroOwner(reserved.registration.objectId))
      .rejects.toMatchObject({ code: "owners_present" });
    expect(purge).not.toHaveBeenCalled();
    await sql`
      DELETE FROM focowiki.release_catalog_entries
      WHERE knowledge_base_id = 'kb-ownership'
        AND release_root_public_id = 'root-active'
        AND logical_path = 'delete-guard.md'
    `;
    await expect(deletion.deleteZeroOwner(reserved.registration.objectId)).resolves.toMatchObject({
      deletedVersions: 1
    });
    await expect(repository.getRegistration(reserved.registration.objectId)).resolves.toMatchObject({
      state: "deleted"
    });
  });
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
