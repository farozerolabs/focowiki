import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresImmutableObjectRepository } from "../src/infrastructure/postgres/immutable-object-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("immutable object repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = createPostgresImmutableObjectRepository(sql);
  const checksumSha256 = "91".repeat(32);
  const knowledgeBaseId = "kb-immutable-object-integration";
  const generationId = "generation-immutable-object-integration";

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.generation_object_refs WHERE generation_id = ${generationId}`;
    await sql`DELETE FROM focowiki.publication_generations WHERE id = ${generationId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`
      DELETE FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${checksumSha256} AND format_version = 1
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM focowiki.generation_object_refs WHERE generation_id = ${generationId}`;
    await sql`DELETE FROM focowiki.publication_generations WHERE id = ${generationId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`
      DELETE FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${checksumSha256} AND format_version = 1
    `;
    await sql.end({ timeout: 5 });
  });

  it("releases only the owned unreferenced writing reservation", async () => {
    await reserve("owned-token");

    await expect(repository.releaseFailedWrite({
      checksumSha256,
      formatVersion: 1,
      writeToken: "different-token"
    })).resolves.toBe(false);
    await expect(repository.findAny({ checksumSha256, formatVersion: 1 }))
      .resolves.not.toBeNull();

    await expect(repository.releaseFailedWrite({
      checksumSha256,
      formatVersion: 1,
      writeToken: "owned-token"
    })).resolves.toBe(true);
    await expect(repository.findAny({ checksumSha256, formatVersion: 1 }))
      .resolves.toBeNull();
  });

  it("preserves a reservation that has acquired a generation reference", async () => {
    await reserve("referenced-token");
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Immutable object integration')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, generation_kind
      ) VALUES (${generationId}, ${knowledgeBaseId}, 'open', 'normal')
    `;
    await sql`
      INSERT INTO focowiki.generation_object_refs (
        generation_id, knowledge_base_id, ref_kind, ref_key, file_id,
        action, checksum_sha256, format_version
      ) VALUES (
        ${generationId}, ${knowledgeBaseId}, 'projection_shard', 'test:ref',
        'bundle-file-test', 'upsert', ${checksumSha256}, 1
      )
    `;

    await expect(repository.releaseFailedWrite({
      checksumSha256,
      formatVersion: 1,
      writeToken: "referenced-token"
    })).resolves.toBe(false);
    await expect(repository.findAny({ checksumSha256, formatVersion: 1 }))
      .resolves.toMatchObject({ lifecycleState: "writing", writeToken: "referenced-token" });
  });

  it("releases a failed recovery lease without violating the writing-state constraint", async () => {
    await reserve("recovery-token");

    await expect(repository.releaseRecoveryFailure({
      checksumSha256,
      formatVersion: 1,
      recoveryToken: "recovery-token"
    })).resolves.toBe(true);
    await expect(repository.findAny({ checksumSha256, formatVersion: 1 }))
      .resolves.toBeNull();
  });

  it("returns a non-owning deferral while the immutable object is being deleted", async () => {
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        lifecycle_state, deletion_job_id, created_at
      ) VALUES (
        ${checksumSha256}, 1, ${`test/objects/v1/${checksumSha256}`},
        'application/json', 128, 'deleting', 'cleanup-test',
        '2026-07-19T12:00:00.000Z'
      )
    `;

    await expect(repository.reserve({
      checksumSha256,
      formatVersion: 1,
      objectKey: `test/objects/v1/${checksumSha256}`,
      contentType: "application/json",
      sizeBytes: 128,
      writeToken: "replacement-token",
      writeStartedAt: "2026-07-19T12:01:00.000Z",
      staleBefore: "2026-07-19T11:56:00.000Z"
    })).resolves.toEqual({ status: "deleting", record: null });
  });

  async function reserve(writeToken: string): Promise<void> {
    const result = await repository.reserve({
      checksumSha256,
      formatVersion: 1,
      objectKey: `test/objects/v1/${checksumSha256}`,
      contentType: "application/json",
      sizeBytes: 128,
      writeToken,
      writeStartedAt: "2026-07-19T12:00:00.000Z",
      staleBefore: "2026-07-19T11:55:00.000Z"
    });
    expect(result.status).toBe("reserved");
  }
});
