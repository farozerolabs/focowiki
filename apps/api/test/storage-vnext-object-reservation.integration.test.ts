import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresStorageVnextOwnershipRepository } from
  "../src/storage-vnext/ownership/postgres-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const describeOwnedDatabase = enabled ? describe : describe.skip;

describeOwnedDatabase("storage vNext object reservation leases", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = "focowiki_reservation_"
    + (runOwner ?? "invalid").replaceAll("-", "_") + "_"
    + randomUUID().replaceAll("-", "").slice(0, 10);
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 2 });
  let created = false;

  beforeAll(async () => {
    await admin.unsafe("CREATE DATABASE " + quote(databaseName));
    created = true;
    await applyStorageVnextTestMigrations(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (created) {
      await admin.unsafe(
        "DROP DATABASE IF EXISTS " + quote(databaseName) + " WITH (FORCE)"
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("rejects a live writer and deterministically transfers an expired lease", async () => {
    const repository = createPostgresStorageVnextOwnershipRepository(
      sql as unknown as DatabaseClient
    );
    const reservation = {
      objectId: "source-sha256:" + "a".repeat(64),
      storageKey: "runs/reservation/source.md",
      checksum: "a".repeat(64),
      byteCount: 10,
      contentType: "text/markdown; charset=utf-8",
      format: "source-markdown-v1",
      writeAttemptPublicId: "write-reservation-first",
      createdAt: "2026-08-17T00:00:00.000Z",
      reservationExpiresAt: "2026-08-17T00:00:01.000Z"
    };
    await expect(repository.reserve(reservation)).resolves.toMatchObject({
      outcome: "reserved",
      registration: { writeAttemptPublicId: "write-reservation-first" }
    });
    await expect(repository.reserve({
      ...reservation,
      writeAttemptPublicId: "write-reservation-live-conflict",
      createdAt: "2026-08-17T00:00:00.500Z",
      reservationExpiresAt: "2026-08-17T00:00:01.500Z"
    })).rejects.toMatchObject({ code: "write_in_progress" });
    await expect(repository.reserve({
      ...reservation,
      writeAttemptPublicId: "write-reservation-takeover",
      createdAt: "2026-08-17T00:00:01.000Z",
      reservationExpiresAt: "2026-08-17T00:00:02.000Z"
    })).resolves.toMatchObject({
      outcome: "reserved",
      registration: { writeAttemptPublicId: "write-reservation-takeover" }
    });
    await expect(repository.markVerified({
      objectId: reservation.objectId,
      writeAttemptPublicId: "write-reservation-first",
      checksum: reservation.checksum,
      byteCount: reservation.byteCount,
      contentType: reservation.contentType,
      format: reservation.format,
      verifiedAt: "2026-08-17T00:00:01.500Z"
    })).rejects.toMatchObject({ code: "write_attempt_conflict" });
    await expect(repository.markVerified({
      objectId: reservation.objectId,
      writeAttemptPublicId: "write-reservation-takeover",
      checksum: reservation.checksum,
      byteCount: reservation.byteCount,
      contentType: reservation.contentType,
      format: reservation.format,
      verifiedAt: "2026-08-17T00:00:01.500Z"
    })).resolves.toMatchObject({ state: "verified" });
    await expect(sql<Array<{ reservation_expires_at: Date | null }>>`
      SELECT reservation_expires_at
      FROM focowiki.object_registrations
      WHERE object_id = ${reservation.objectId}
    `).resolves.toEqual([{ reservation_expires_at: null }]);

    await expect(repository.reserve({
      ...reservation,
      writeAttemptPublicId: "write-reservation-projection",
      createdAt: "2099-08-17T00:00:02.000Z",
      reservationExpiresAt: "2099-08-17T00:00:32.000Z",
      holdVerifiedUntil: "2099-08-17T00:00:32.000Z"
    })).resolves.toMatchObject({
      outcome: "reused",
      registration: {
        state: "verified",
        writeAttemptPublicId: "write-reservation-projection"
      }
    });
    await expect(repository.markDeleting(reservation.objectId))
      .rejects.toMatchObject({ code: "write_in_progress" });
    await expect(repository.releaseVerifiedReservation({
      objectId: reservation.objectId,
      writeAttemptPublicId: "write-reservation-projection"
    })).resolves.toBeUndefined();
    await expect(repository.markDeleting(reservation.objectId))
      .resolves.toBeUndefined();
  });

  it("treats an active generated page head as a durable object reference", async () => {
    const repository = createPostgresStorageVnextOwnershipRepository(
      sql as unknown as DatabaseClient
    );
    const objectId = "generated-sha256:okf-generated-json-v1:" + "b".repeat(64);
    const reservation = {
      objectId,
      storageKey: "runs/reservation/active-graph.json",
      checksum: "b".repeat(64),
      byteCount: 32,
      contentType: "application/json; charset=utf-8",
      format: "okf-generated-json-v1",
      writeAttemptPublicId: "write-active-graph",
      createdAt: "2026-08-17T01:00:00.000Z"
    };
    await repository.reserve(reservation);
    await repository.markVerified({
      ...reservation,
      verifiedAt: "2026-08-17T01:00:01.000Z"
    });
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('knowledge-base-active-head', 'Active head', 1)
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        page_candidate_public_id, object_id, checksum_sha256,
        byte_count, activation_revision
      ) VALUES (
        'knowledge-base-active-head', '_graph/active.json',
        '_graph/active.json', 'graph', NULL, ${objectId},
        ${reservation.checksum}, ${reservation.byteCount}, 1
      )
    `;
    await expect(repository.markDeleting(objectId))
      .rejects.toMatchObject({ code: "owners_present" });
  });
});

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = "/" + databaseName;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
