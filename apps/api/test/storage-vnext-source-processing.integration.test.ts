import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { generatedPagePath } from "../src/domain/source-path.js";
import { createPostgresStorageVnextCatalogRepository } from
  "../src/storage-vnext/catalog/postgres-repository.js";
import { createPostgresStorageVnextGraphRepository } from
  "../src/storage-vnext/graph/postgres-repository.js";
import { createPostgresStorageVnextReleaseRepository } from
  "../src/storage-vnext/release/postgres-repository.js";
import { createStorageVnextSourceReleaseHandoff } from
  "../src/storage-vnext/source-processing/release-handoff.js";
import { createStorageVnextSourceProcessingWorker } from
  "../src/storage-vnext/source-processing/worker.js";
import { createPostgresStorageVnextSourceEventRepository } from
  "../src/storage-vnext/source-events/postgres-repository.js";
import { createStorageVnextUploadCoordinator } from
  "../src/storage-vnext/upload/upload-coordinator.js";
import { createPostgresStorageVnextUploadRepository } from
  "../src/storage-vnext/upload/postgres-repository.js";
import { createPostgresStorageVnextUploadTerminalPort } from
  "../src/storage-vnext/upload/postgres-terminal.js";
import { createPostgresStorageVnextWorkflowRepository } from
  "../src/storage-vnext/workflow/postgres-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext source processing PostgreSQL handoff", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = "focowiki_vnext_source_" + ownerToken + "_"
    + randomUUID().replaceAll("-", "").slice(0, 10);
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 6 });
  const database = sql as unknown as DatabaseClient;
  const workflow = createPostgresStorageVnextWorkflowRepository(database);
  const catalog = createPostgresStorageVnextCatalogRepository(database);
  const graph = createPostgresStorageVnextGraphRepository(database);
  const releases = createPostgresStorageVnextReleaseRepository(database);
  const events = createPostgresStorageVnextSourceEventRepository(database);
  const handoff = createStorageVnextSourceReleaseHandoff({
    graph,
    releases,
    workflow,
    publicationDelayMilliseconds: 30_000,
    resultRetentionMilliseconds: 86_400_000
  });
  const bodyPlane = createDatabaseBackedBodyPlane(sql);
  const upload = createStorageVnextUploadCoordinator({
    repository: createPostgresStorageVnextUploadRepository(database, {
      sourceWorkRetentionMilliseconds: 86_400_000
    }),
    terminal: createPostgresStorageVnextUploadTerminalPort(database, {
      resultRetentionMilliseconds: 86_400_000
    }),
    bodyWriter: bodyPlane.writer,
    limits: { maximumEntries: 100, maximumManifestBytes: 262_144 }
  });
  const model = {
    extract: vi.fn(async (input: {
      sourceFile: {
        publicId: string;
        knowledgeBaseId: string;
        logicalPath: string;
        title: string;
      };
      sourceRevision: { publicId: string };
      body: AsyncIterable<Uint8Array>;
    }) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.body) chunks.push(chunk);
      expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"))
        .toBe("# Durable handoff\n");
      return {
        modelAssistanceUsed: false,
        metadata: { headingCount: 1 },
        node: {
          publicId: "node-source-integration",
          knowledgeBaseId: input.sourceFile.knowledgeBaseId,
          sourceFilePublicId: input.sourceFile.publicId,
          sourceRevisionPublicId: input.sourceRevision.publicId,
          logicalPath: generatedPagePath(input.sourceFile.logicalPath),
          label: input.sourceFile.title,
          kind: "document",
          metadata: {},
          evidence: [],
          revision: 1
        },
        edges: []
      };
    })
  };
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe("CREATE DATABASE " + quoteIdentifier(databaseName));
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql.unsafe(
      "INSERT INTO focowiki.runtime_setting_revisions "
      + "(public_id, checksum_sha256, settings_values) VALUES ($1, $2, '{}'::jsonb)",
      ["settings-source-integration", "b".repeat(64)]
    );
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        "DROP DATABASE IF EXISTS " + quoteIdentifier(databaseName) + " WITH (FORCE)"
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("moves one accepted revision through graph facts into the single release candidate", async () => {
    const startedAt = new Date();
    const completedAt = new Date(startedAt.getTime() + 1_000);
    await sql.unsafe(
      "INSERT INTO focowiki.knowledge_bases (public_id, name, revision) VALUES ($1, $2, 1)",
      ["kb-source-integration", "Source integration"]
    );
    const body = Buffer.from("# Durable handoff\n", "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const entry = {
      entryPublicId: "entry-source-integration",
      sourceFilePublicId: "file-source-integration",
      logicalPath: "Guides/Durable.md",
      byteCount: body.byteLength,
      checksumSha256: checksum,
      contentType: "text/markdown; charset=utf-8"
    } as const;
    await upload.openSession({
      knowledgeBaseId: "kb-source-integration",
      operationPublicId: "operation-upload-source-integration",
      sessionPublicId: "upload-source-integration",
      idempotencyKey: "request-upload-source-integration",
      settingsRevisionPublicId: "settings-source-integration",
      entries: [entry],
      createdAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + 3_600_000).toISOString()
    });
    await upload.putEntry({
      knowledgeBaseId: "kb-source-integration",
      sessionPublicId: "upload-source-integration",
      entryPublicId: entry.entryPublicId,
      body: bodyChunks(body)
    });
    await upload.finalizeSession({
      knowledgeBaseId: "kb-source-integration",
      sessionPublicId: "upload-source-integration",
      completedAt: completedAt.toISOString()
    });

    const worker = createStorageVnextSourceProcessingWorker({
      workflow,
      catalog,
      bodyStore: bodyPlane.reader,
      model,
      modelInvocation: null,
      handoff,
      events,
      limits: {
        maximumConcurrency: 2,
        maximumSourceBytes: 1_048_576,
        maximumAttempts: 3,
        attemptDeadlineMilliseconds: 30_000,
        retryDelayMilliseconds: 60_000,
        resultRetentionMilliseconds: 86_400_000
      },
      clock: () => completedAt.toISOString()
    });
    const run = {
      owner: "source-worker-integration",
      limit: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    await expect(worker.runOnce(run)).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      terminal: 0
    });
    run.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    await expect(worker.runOnce(run)).resolves.toEqual({
      claimed: 0,
      completed: 0,
      retried: 0,
      terminal: 0
    });

    const facts = await sql.unsafe(
      "SELECT "
      + "(SELECT status FROM focowiki.source_files "
      + " WHERE public_id = 'file-source-integration') AS source_status, "
      + "(SELECT count(*) FROM focowiki.source_revisions "
      + " WHERE knowledge_base_id = 'kb-source-integration') AS source_revision_count, "
      + "(SELECT count(*) FROM focowiki.operation_work_items "
      + " WHERE knowledge_base_id = 'kb-source-integration' AND work_kind = 'source') "
      + " AS source_work_count, "
      + "(SELECT count(*) FROM focowiki.operation_results "
      + " WHERE knowledge_base_id = 'kb-source-integration' AND operation_kind = 'source') "
      + " AS source_result_count, "
      + "(SELECT count(*) FROM focowiki.graph_nodes "
      + " WHERE knowledge_base_id = 'kb-source-integration') AS graph_node_count, "
      + "(SELECT count(*) FROM focowiki.release_candidates "
      + " WHERE knowledge_base_id = 'kb-source-integration' "
      + " AND state IN ('building', 'validating', 'ready')) AS candidate_count, "
      + "(SELECT count(*) FROM focowiki.release_candidate_changed_facts "
      + " WHERE knowledge_base_id = 'kb-source-integration') AS changed_fact_count, "
      + "(SELECT count(*) FROM focowiki.search_projections "
      + " WHERE knowledge_base_id = 'kb-source-integration') AS search_projection_count, "
      + "(SELECT count(*) FROM focowiki.object_registrations) AS object_count"
    ) as unknown as Array<Record<string, string>>;
    expect(facts[0]).toEqual({
      source_status: "ready",
      source_revision_count: "1",
      source_work_count: "0",
      source_result_count: "1",
      graph_node_count: "1",
      candidate_count: "1",
      changed_fact_count: "1",
      search_projection_count: "0",
      object_count: "1"
    });
    expect(model.extract).toHaveBeenCalledTimes(1);
    expect(bodyPlane.writeCount).toBe(1);
  });

  it("keeps upload acceptance responsive while source processing is backpressured", async () => {
    await sql.unsafe(
      "INSERT INTO focowiki.knowledge_bases (public_id, name, revision) VALUES ($1, $2, 1)",
      ["kb-source-backpressure", "Source backpressure"]
    );
    await acceptEntry({
      suffix: "backpressure-one",
      logicalPath: "Guides/BackpressureOne.md",
      body: "# Backpressure one\n"
    });
    let releaseModel: () => void = () => undefined;
    let announceStarted: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let modelCallCount = 0;
    const pressuredModel = {
      async extract(input: {
        sourceFile: {
          publicId: string;
          knowledgeBaseId: string;
          logicalPath: string;
          title: string;
        };
        sourceRevision: { publicId: string };
        body: AsyncIterable<Uint8Array>;
      }) {
        for await (const _chunk of input.body) {
          // Consume the verified stream before model backpressure is released.
        }
        modelCallCount += 1;
        if (modelCallCount === 1) {
          announceStarted();
          await gate;
        }
        return {
          modelAssistanceUsed: false,
          metadata: { headingCount: 1 },
          node: {
            publicId: "node-" + input.sourceFile.publicId,
            knowledgeBaseId: input.sourceFile.knowledgeBaseId,
            sourceFilePublicId: input.sourceFile.publicId,
            sourceRevisionPublicId: input.sourceRevision.publicId,
            logicalPath: generatedPagePath(input.sourceFile.logicalPath),
            label: input.sourceFile.title,
            kind: "document",
            metadata: {},
            evidence: [],
            revision: 1
          },
          edges: []
        };
      }
    };
    const worker = createStorageVnextSourceProcessingWorker({
      workflow,
      catalog,
      bodyStore: bodyPlane.reader,
      model: pressuredModel,
      modelInvocation: null,
      handoff,
      events,
      limits: {
        maximumConcurrency: 1,
        maximumSourceBytes: 1_048_576,
        maximumAttempts: 3,
        attemptDeadlineMilliseconds: 30_000,
        retryDelayMilliseconds: 60_000,
        resultRetentionMilliseconds: 86_400_000
      },
      clock: () => new Date().toISOString()
    });
    const timeoutCountBefore = timeoutResourceCount();
    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const firstProcessing = worker.runOnce({
      owner: "source-worker-backpressure",
      limit: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await started;

    const acceptanceStartedAt = performance.now();
    await acceptEntry({
      suffix: "backpressure-two",
      logicalPath: "Guides/BackpressureTwo.md",
      body: "# Backpressure two\n"
    });
    expect(performance.now() - acceptanceStartedAt).toBeLessThan(1_000);

    releaseModel();
    await expect(firstProcessing).resolves.toMatchObject({ completed: 1 });
    await expect(worker.runOnce({
      owner: "source-worker-backpressure",
      limit: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })).resolves.toMatchObject({ completed: 1 });

    expect(timeoutResourceCount()).toBeLessThanOrEqual(timeoutCountBefore);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(64 * 1_024 * 1_024);
    const cpu = process.cpuUsage(cpuBefore);
    expect(cpu.user + cpu.system).toBeLessThan(1_000_000);
    const idle = await sql.unsafe(
      "SELECT "
      + "(SELECT count(*) FROM focowiki.operation_work_items "
      + " WHERE knowledge_base_id = 'kb-source-backpressure' AND work_kind = 'source') "
      + " AS source_work_count, "
      + "(SELECT count(*) FROM focowiki.release_candidates "
      + " WHERE knowledge_base_id = 'kb-source-backpressure' "
      + " AND state IN ('building', 'validating', 'ready')) AS candidate_count, "
      + "(SELECT count(*) FROM focowiki.search_projections "
      + " WHERE knowledge_base_id = 'kb-source-backpressure') AS search_projection_count, "
      + "(SELECT count(*) FROM pg_stat_activity "
      + " WHERE datname = current_database() AND pid <> pg_backend_pid() "
      + " AND state <> 'idle') AS active_connection_count"
    ) as unknown as Array<Record<string, string>>;
    expect(idle[0]).toEqual({
      source_work_count: "0",
      candidate_count: "1",
      search_projection_count: "0",
      active_connection_count: "0"
    });
  });

  async function acceptEntry(input: {
    suffix: string;
    logicalPath: string;
    body: string;
  }): Promise<void> {
    const startedAt = new Date();
    const bytes = Buffer.from(input.body, "utf8");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await upload.openSession({
      knowledgeBaseId: "kb-source-backpressure",
      operationPublicId: "operation-upload-" + input.suffix,
      sessionPublicId: "upload-" + input.suffix,
      idempotencyKey: "request-upload-" + input.suffix,
      settingsRevisionPublicId: "settings-source-integration",
      entries: [{
        entryPublicId: "entry-" + input.suffix,
        sourceFilePublicId: "file-" + input.suffix,
        logicalPath: input.logicalPath,
        byteCount: bytes.byteLength,
        checksumSha256: checksum,
        contentType: "text/markdown; charset=utf-8"
      }],
      createdAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + 3_600_000).toISOString()
    });
    await upload.putEntry({
      knowledgeBaseId: "kb-source-backpressure",
      sessionPublicId: "upload-" + input.suffix,
      entryPublicId: "entry-" + input.suffix,
      body: bodyChunks(bytes)
    });
    await upload.finalizeSession({
      knowledgeBaseId: "kb-source-backpressure",
      sessionPublicId: "upload-" + input.suffix,
      completedAt: new Date(startedAt.getTime() + 1).toISOString()
    });
  }
});

function createDatabaseBackedBodyPlane(sql: postgres.Sql) {
  const bodies = new Map<string, Uint8Array>();
  let writeCount = 0;
  return {
    writer: {
      async putVerifiedStream(input: {
        body: AsyncIterable<Uint8Array>;
        checksumSha256: string;
        byteCount: number;
        contentType: string;
        writeAttemptPublicId: string;
      }) {
        const values: Uint8Array[] = [];
        for await (const chunk of input.body) values.push(chunk);
        const bytes = Buffer.concat(values.map((chunk) => Buffer.from(chunk)));
        const objectId = "source-sha256:" + input.checksumSha256;
        const existed = bodies.has(objectId);
        if (!existed) {
          bodies.set(objectId, bytes);
          writeCount += 1;
        }
        await sql.unsafe(
          "INSERT INTO focowiki.object_registrations "
          + "(object_id, storage_key, checksum_sha256, byte_count, content_type, "
          + " object_format, state, write_attempt_public_id, verified_at, created_at) "
          + "VALUES ($1, $2, $3, $4, $5, 'source-markdown-v1', "
          + " 'verified', $6, now(), now()) ON CONFLICT (object_id) DO NOTHING",
          [
            objectId,
            "run-owned/source/" + input.checksumSha256 + ".md",
            input.checksumSha256,
            input.byteCount,
            input.contentType,
            input.writeAttemptPublicId
          ]
        );
        return {
          outcome: existed ? "reused" as const : "stored" as const,
          objectId,
          checksumSha256: input.checksumSha256,
          byteCount: input.byteCount,
          contentType: input.contentType
        };
      }
    },
    reader: {
      async readVerifiedStream(input: {
        objectId: string;
        checksum: string;
        byteCount: number;
      }): Promise<AsyncIterable<Uint8Array>> {
        const body = bodies.get(input.objectId);
        if (
          !body
          || body.byteLength !== input.byteCount
          || createHash("sha256").update(body).digest("hex") !== input.checksum
        ) throw new Error("Missing verified body fixture");
        return bodyChunks(body);
      }
    },
    get writeCount() {
      return writeCount;
    }
  };
}

async function* bodyChunks(body: Uint8Array): AsyncGenerator<Uint8Array> {
  yield body.slice(0, 5);
  yield body.slice(5);
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = "/" + databaseName;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return "\"" + value.replaceAll("\"", "\"\"") + "\"";
}

function timeoutResourceCount(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
}
