import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import {
  createPostgresStorageVnextSourceEventRepository
} from "../src/storage-vnext/source-events/postgres-repository.js";
import type {
  StorageVnextSourceEventSummary
} from "../src/storage-vnext/source-events/ports.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext source event PostgreSQL repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_source_events_${ownerToken}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 3 });
  const database = sql as unknown as DatabaseClient;
  const repository = createPostgresStorageVnextSourceEventRepository(database);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await sql.unsafe(readFileSync(
      resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
      "utf8"
    ));
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('kb-source-events', 'Source events', 1)
    `;
    await sql`
      INSERT INTO focowiki.source_files
        (public_id, knowledge_base_id, logical_path, normalized_path,
         title, metadata, status, revision)
      VALUES
        ('file-source-events', 'kb-source-events', 'Events.md', 'events.md',
         'Events', '{}'::jsonb, 'processing', 1)
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

  it("records idempotent chronological events and paginates with a scoped cursor", async () => {
    const accepted = sourceEvent("accepted", 10, "upload_storage");
    const progress = sourceEvent("progress", 20, "metadata_resolution");
    const completed = {
      ...sourceEvent("completed", 30, "generation_activation"),
      endedAt: "2030-08-01T00:00:00.000Z"
    };

    await repository.record(accepted);
    await repository.record(progress);
    await repository.record(completed);
    await expect(repository.record(progress)).resolves.toBeUndefined();

    const first = await repository.list({
      knowledgeBaseId: "kb-source-events",
      sourceFileId: "file-source-events",
      limit: 2,
      cursor: null
    });
    expect(first.items.map((event) => event.publicId)).toEqual([
      "source-event-accepted",
      "source-event-progress"
    ]);
    expect(first.items.map((event) => event.endedAt)).toEqual([
      "2030-08-01T00:00:00.000Z",
      "2030-08-01T00:00:00.000Z"
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));

    await expect(repository.list({
      knowledgeBaseId: "kb-source-events",
      sourceFileId: "file-source-events",
      limit: 2,
      cursor: first.nextCursor
    })).resolves.toMatchObject({
      items: [{ publicId: "source-event-completed", endedAt: completed.endedAt }],
      nextCursor: null
    });

    await expect(repository.list({
      knowledgeBaseId: "kb-source-events",
      sourceFileId: "another-file",
      limit: 2,
      cursor: first.nextCursor
    })).rejects.toMatchObject({ code: "invalid_cursor" });
  });
});

function sourceEvent(
  kind: string,
  sequence: number,
  stageKey: StorageVnextSourceEventSummary["stageKey"]
): StorageVnextSourceEventSummary {
  return {
    publicId: `source-event-${kind}`,
    knowledgeBaseId: "kb-source-events",
    sourceFilePublicId: "file-source-events",
    sourceRevisionPublicId: "revision-source-events",
    sequence,
    stageKey,
    messageKey: `sourceFiles.phase.${kind}`,
    startedAt: "2030-08-01T00:00:00.000Z",
    endedAt: null,
    severity: "info",
    createdAt: "2030-08-01T00:00:00.000Z",
    expiresAt: "2030-09-01T00:00:00.000Z"
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
