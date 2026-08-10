import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";
import { createPostgresRerankerConfigurationRepository } from
  "../src/semantic/infrastructure/postgres-reranker-configuration-repository.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("reranker configuration PostgreSQL repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const owner = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_reranker_${owner}_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const repository = createPostgresRerankerConfigurationRepository(sql);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
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

  it("persists revisions, validation, active selection, and credential cleanup", async () => {
    const created = await repository.create({
      configurationPublicId: "reranker-config-a",
      revisionPublicId: "reranker-revision-a1",
      ...write("encrypted-a"),
      createdAt: "2026-08-09T00:00:00.000Z"
    });
    const revised = await repository.createRevision({
      configurationPublicId: created.publicId,
      revisionPublicId: "reranker-revision-a2",
      ...write("encrypted-a"),
      displayName: "Reranker revised",
      expectedConfigurationRevision: 1,
      createdAt: "2026-08-09T00:01:00.000Z"
    });
    await repository.recordValidation({
      configurationPublicId: created.publicId,
      revisionPublicId: revised.revisionPublicId,
      status: "valid",
      validationFingerprintSha256: "a".repeat(64),
      safeValidationErrorCode: null,
      validatedAt: "2026-08-09T00:02:00.000Z"
    });
    await expect(repository.setLifecycle({
      configurationPublicId: created.publicId,
      status: "active",
      expectedConfigurationRevision: 2
    })).resolves.toMatchObject({
      lifecycleStatus: "active",
      validationStatus: "valid",
      encryptedApiKey: "encrypted-a"
    });
    await expect(repository.getActive()).resolves.toMatchObject({
      revisionPublicId: "reranker-revision-a2"
    });
    await repository.setLifecycle({
      configurationPublicId: created.publicId,
      status: "paused",
      expectedConfigurationRevision: 3
    });
    await expect(repository.delete({
      configurationPublicId: created.publicId,
      expectedConfigurationRevision: 4,
      deletedAt: "2026-08-09T00:03:00.000Z"
    })).resolves.toBe(true);
    const rows = await sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count
      FROM focowiki.reranker_configuration_revisions
      WHERE configuration_public_id = 'reranker-config-a'
    `;
    expect(Number(rows[0]?.count)).toBe(0);
  });

  function write(encryptedApiKey: string) {
    return {
      displayName: "Reranker",
      authenticationMode: "api_key" as const,
      baseUrl: "https://reranker.example/v1",
      encryptedApiKey,
      modelName: "rerank-model",
      timeoutMs: 1_500,
      retryCount: 1,
      minimumIntervalMs: 20,
      concurrency: 4
    };
  }
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  const quote = String.fromCharCode(34);
  return quote + value.replaceAll(quote, quote + quote) + quote;
}
