import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { loadEnvFile } from "node:process";
import postgres from "postgres";
import type {
  ProjectionRepairWorkItem
} from "../src/application/ports/projection-repair-work-repository.js";
import { applyMigrations } from "../src/db/migrations.js";
import { createPostgresProjectionRepairBuildRepository } from
  "../src/infrastructure/postgres/projection-repair-build-repository.js";
import { createPostgresProjectionRepairWorkRepository } from
  "../src/infrastructure/postgres/projection-repair-work-repository.js";
import {
  CURRENT_PROJECTION_REPAIR_PLANNER_VERSION,
  CURRENT_PROJECTION_REPAIR_VERSION,
  type ProjectionRepairSettingsSnapshot
} from "../src/maintenance/projection-repair-plan.js";
import {
  createProjectionRepairDirectoryStream
} from "../src/maintenance/projection-repair-directory-builder.js";

const reportDirectory = resolve(
  process.cwd(),
  "../../ReferenceDocs/performance/projection-repair"
);
const fixtureSizes = readFixtureSizes();
const resourceSampleIntervalMs = 250;
const readProbeConcurrency = 4;
const settings: ProjectionRepairSettingsSnapshot = {
  concurrency: 4,
  databaseBatchSize: 2_000,
  objectWriteConcurrency: 8
};

loadLocalEnvironment();
const sourceDatabaseUrl = readDatabaseUrl();

async function main(): Promise<void> {
  const baseline = JSON.parse(
    await readFile(resolve(reportDirectory, "baseline.json"), "utf8")
  ) as BenchmarkReport;
  const cases = [];
  for (const size of fixtureSizes) {
    cases.push(await runFixture(size));
  }
  const report: BenchmarkReport = {
    schemaVersion: 1,
    kind: "projection-repair-optimized",
    generatedAt: new Date().toISOString(),
    implementation: {
      repairVersion: CURRENT_PROJECTION_REPAIR_VERSION,
      treeWriteMode: "postgres-set-based-batches",
      directoryWriteMode: "directory-owned-final-leaves",
      graphCountMode: "postgres-filtered-aggregate",
      workerOwner: "projection-repair-worker"
    },
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpuCount: navigator.hardwareConcurrency,
      databaseHostClass: "local-compose",
      externalStorageUsed: false,
      externalModelUsed: false
    },
    profile: {
      fixtureSizes,
      databaseBatchSize: settings.databaseBatchSize,
      repairConcurrency: settings.concurrency,
      resourceSampleIntervalMs,
      readProbeConcurrency
    },
    cases
  };
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    resolve(reportDirectory, "optimized.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    resolve(reportDirectory, "optimized.md"),
    renderOptimizedMarkdown(report),
    "utf8"
  );
  await writeFile(
    resolve(reportDirectory, "comparison.md"),
    renderComparisonMarkdown(baseline, report),
    "utf8"
  );
  console.log(JSON.stringify(report, null, 2));
}

async function runFixture(size: number): Promise<BenchmarkCase> {
  const databaseName = `focowiki_projection_repair_v4_${size}_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 8)
  }`;
  const metrics = createQueryMetrics();
  const admin = postgres(databaseConnectionUrl(sourceDatabaseUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(sourceDatabaseUrl, databaseName), {
    max: 16,
    debug: (_connection, query) => metrics.observe(query)
  });
  const probeSql = postgres(databaseConnectionUrl(sourceDatabaseUrl, databaseName), {
    max: readProbeConcurrency
  });
  try {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
    const fixture = await seedFixture(sql, size);
    metrics.reset();
    const resources = createResourceSampler();
    const eventLoop = monitorEventLoopDelay({ resolution: 20 });
    resources.start();
    eventLoop.enable();
    const cpuStart = process.cpuUsage();
    const startedAt = performance.now();
    const executionPromise = executeOptimizedRepair({
      sql,
      knowledgeBaseId: fixture.knowledgeBaseId,
      targetGenerationId: fixture.targetGenerationId
    });
    const probePromise = measureReadProbesUntilComplete(
      probeSql,
      fixture.knowledgeBaseId,
      executionPromise
    );
    const [execution, readProbes] = await Promise.all([executionPromise, probePromise]);
    const durationMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuStart);
    const resource = resources.stop();
    eventLoop.disable();
    const outputCounts = await readOutputCounts(sql, fixture.targetGenerationId);
    return {
      size,
      durationMs: round(durationMs),
      recordsPerSecond: round(size / (durationMs / 1_000)),
      phaseDurationMs: execution.phaseDurationMs,
      subtaskCount: execution.subtaskCount,
      sqlStatementCount: metrics.total,
      sqlStatementsByOperation: metrics.byOperation,
      logicalShardWriteCount: execution.logicalShardWriteCount,
      logicalDirectoryWriteCount: execution.logicalDirectoryWriteCount,
      logicalRootWriteCount: execution.logicalRootWriteCount,
      logicalObjectReuseCount: execution.logicalObjectReuseCount,
      retryCount: execution.retryCount,
      cpuUserMs: round(cpu.user / 1_000),
      cpuSystemMs: round(cpu.system / 1_000),
      rssPeakBytes: resource.rssPeakBytes,
      rssGrowthBytes: resource.rssPeakBytes - resource.rssStartBytes,
      eventLoopDelayP95Ms: round(eventLoop.percentile(95) / 1_000_000),
      readProbes,
      outputCounts
    };
  } finally {
    await probeSql.end({ timeout: 5 }).catch(() => undefined);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}

async function executeOptimizedRepair(input: {
  sql: ReturnType<typeof postgres>;
  knowledgeBaseId: string;
  targetGenerationId: string;
}) {
  const work = createPostgresProjectionRepairWorkRepository(input.sql);
  const builds = createPostgresProjectionRepairBuildRepository(input.sql);
  const phaseDurationMs: Record<string, number> = {};
  let subtaskCount = 0;
  let logicalShardWriteCount = 0;
  let logicalDirectoryWriteCount = 0;
  let logicalRootWriteCount = 0;
  let logicalObjectReuseCount = 0;
  let retryCount = 0;
  const now = new Date().toISOString();
  await work.bootstrap({
    repairVersion: CURRENT_PROJECTION_REPAIR_VERSION,
    plannerVersion: CURRENT_PROJECTION_REPAIR_PLANNER_VERSION,
    settingsRevision: 1,
    settings,
    maxAttempts: 5,
    now
  });
  const plan = await work.planNext({
    repairVersion: CURRENT_PROJECTION_REPAIR_VERSION,
    plannerVersion: CURRENT_PROJECTION_REPAIR_PLANNER_VERSION,
    targetGenerationId: input.targetGenerationId,
    settingsRevision: 1,
    settings,
    maxAttempts: 5,
    now
  });
  if (!plan || plan.knowledgeBaseId !== input.knowledgeBaseId) {
    throw new Error("Projection repair benchmark plan was not created");
  }

  for (;;) {
    const claimedAt = new Date();
    const tasks = await work.claimBatch({
      repairVersion: CURRENT_PROJECTION_REPAIR_VERSION,
      workerId: "projection-repair-benchmark",
      leaseTokenPrefix: randomUUID(),
      limit: settings.concurrency,
      now: claimedAt.toISOString(),
      leaseExpiresAt: new Date(claimedAt.getTime() + 600_000).toISOString()
    });
    if (tasks.length === 0) break;
    await Promise.all(tasks.map(async (task) => {
      const taskStartedAt = performance.now();
      const result = await executeBenchmarkTask({ sql: input.sql, work, builds, task });
      const durationMs = Math.max(1, performance.now() - taskStartedAt);
      phaseDurationMs[result.phase] = round(
        (phaseDurationMs[result.phase] ?? 0) + durationMs
      );
      logicalShardWriteCount += result.shardWrites;
      logicalDirectoryWriteCount += result.directoryWrites;
      logicalRootWriteCount += result.rootWrites;
      logicalObjectReuseCount += result.objectReuses;
      subtaskCount += 1;
      const completed = await work.completeTask({
        task,
        processedRecordCount: result.processedRecordCount,
        objectWriteCount:
          result.shardWrites + result.directoryWrites + result.rootWrites,
        objectReuseCount: result.objectReuses,
        durationMs,
        completedAt: new Date().toISOString()
      });
      if (!completed) throw new Error("Projection repair benchmark task ownership was lost");
      if (task.kind === "finalize") {
        await activateBenchmarkGeneration(input.sql, task);
        const repairCompleted = await work.completeRepair({
          task,
          activeGenerationId: task.targetGenerationId,
          completedAt: new Date().toISOString()
        });
        if (!repairCompleted) {
          throw new Error("Projection repair benchmark completion failed");
        }
      }
    }));
  }
  return {
    phaseDurationMs,
    subtaskCount,
    logicalShardWriteCount,
    logicalDirectoryWriteCount,
    logicalRootWriteCount,
    logicalObjectReuseCount,
    retryCount
  };
}

async function executeBenchmarkTask(input: {
  sql: ReturnType<typeof postgres>;
  work: ReturnType<typeof createPostgresProjectionRepairWorkRepository>;
  builds: ReturnType<typeof createPostgresProjectionRepairBuildRepository>;
  task: ProjectionRepairWorkItem;
}): Promise<{
  phase: string;
  processedRecordCount: number;
  shardWrites: number;
  directoryWrites: number;
  rootWrites: number;
  objectReuses: number;
}> {
  const { task } = input;
  if (task.kind === "tree_partition") {
    const processedRecordCount = await stageBatches(task, input.work, (cursor) =>
      input.builds.stageTreeBatch({
        task,
        cursor,
        limit: task.settings.databaseBatchSize
      })
    );
    return result("tree", processedRecordCount, { shardWrites: 1 });
  }
  if (task.kind === "directory") {
    await input.builds.resetDirectorySnapshot({ task });
    let directoryWrites = 0;
    const stream = createProjectionRepairDirectoryStream({
      directoryPath: task.partitionKey,
      limits: { maxEntries: 200, maxBytes: 131_072 },
      writeLeaf: async (leaf) => {
        await input.builds.upsertDirectoryLeaf({ task, leaf });
        directoryWrites += 1;
      }
    });
    let cursor = null;
    do {
      const page = await input.builds.listDirectoryEntryPage({
        task,
        cursor,
        limit: task.settings.databaseBatchSize
      });
      for (const entry of page.entries) await stream.add(entry);
      cursor = page.nextCursor;
    } while (cursor);
    const summary = await stream.finish();
    await input.builds.completeDirectorySnapshot({
      task,
      entryCount: summary.entryCount,
      firstLeafId: summary.firstLeafId
    });
    return result("directory", summary.entryCount, {
      directoryWrites,
      rootWrites: 1
    });
  }
  if (task.kind === "graph_partition") {
    const [projectionKind, shardKey] = task.partitionKey.split("\u001f", 2);
    if (
      (projectionKind !== "graph_node" && projectionKind !== "graph_edge")
      || !shardKey
    ) {
      throw new Error("Projection repair benchmark graph partition is invalid");
    }
    const processedRecordCount = await stageBatches(task, input.work, (cursor) =>
      input.builds.stageGraphBatch({
        task,
        projectionKind,
        shardKey,
        cursor,
        limit: task.settings.databaseBatchSize
      })
    );
    return result("graph", processedRecordCount, { shardWrites: 1 });
  }
  if (task.kind === "graph_finalize") {
    const aggregate = await input.builds.aggregateGraph({
      task,
      updatedAt: new Date().toISOString()
    });
    return result("graph", aggregate.nodeCount + aggregate.edgeCount);
  }
  if (task.kind === "finalize") {
    return result("finalizing", 1, { rootWrites: 6 });
  }
  throw new Error(`Unexpected projection repair benchmark task: ${task.kind}`);
}

async function stageBatches(
  task: ProjectionRepairWorkItem,
  work: ReturnType<typeof createPostgresProjectionRepairWorkRepository>,
  stage: (cursor: string | null) => Promise<{
    processedRecordCount: number;
    nextCursor: string | null;
    complete: boolean;
  }>
): Promise<number> {
  let cursor: string | null = null;
  let processed = 0;
  do {
    const startedAt = performance.now();
    const batch = await stage(cursor);
    processed += batch.processedRecordCount;
    cursor = batch.nextCursor;
    const checkpointed = await work.checkpointTask({
      task,
      checkpoint: { cursor },
      processedRecordCount: processed,
      batchDurationMs: Math.max(1, performance.now() - startedAt),
      checkpointedAt: new Date().toISOString()
    });
    if (!checkpointed) throw new Error("Projection repair benchmark checkpoint failed");
    if (batch.complete) break;
  } while (true);
  if (processed !== task.expectedRecordCount) {
    throw new Error("Projection repair benchmark partition parity failed");
  }
  return processed;
}

async function activateBenchmarkGeneration(
  sql: ReturnType<typeof postgres>,
  task: ProjectionRepairWorkItem
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE focowiki.publication_generations
      SET state = 'superseded', successor_generation_id = ${task.targetGenerationId},
          updated_at = now()
      WHERE id = ${task.baseGenerationId}
        AND knowledge_base_id = ${task.knowledgeBaseId}
        AND state = 'active'
    `;
    await transaction`
      UPDATE focowiki.publication_generations
      SET state = 'active', activated_at = now(), updated_at = now()
      WHERE id = ${task.targetGenerationId}
        AND knowledge_base_id = ${task.knowledgeBaseId}
    `;
    await transaction`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${task.targetGenerationId}, updated_at = now()
      WHERE id = ${task.knowledgeBaseId}
        AND active_generation_id = ${task.baseGenerationId}
    `;
  });
}

async function seedFixture(
  sql: ReturnType<typeof postgres>,
  size: number
): Promise<{
  knowledgeBaseId: string;
  targetGenerationId: string;
}> {
  const prefix = `repair-${size}`;
  const knowledgeBaseId = `${prefix}-kb`;
  const activeGenerationId = `${prefix}-active`;
  const targetGenerationId = `${prefix}-candidate`;
  const directoryCount = Math.ceil(size / 1_000);
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO focowiki.knowledge_bases (
        id, name, description, resource_revision
      ) VALUES (
        ${knowledgeBaseId}, ${`Repair scale ${size}`},
        'Domain-neutral repair fixture', 1
      )
    `;
    await transaction`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, generation_kind, activated_at
      ) VALUES (
        ${activeGenerationId}, ${knowledgeBaseId}, 'active', 'normal', now()
      )
    `;
    await transaction`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${activeGenerationId}
      WHERE id = ${knowledgeBaseId}
    `;
    await transaction`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, logical_path,
        parent_path, sort_key, title, searchable_text, payload_json
      ) VALUES (
        ${knowledgeBaseId}, 'tree', 'directory:',
        ${activeGenerationId}, 'tree/v1/0000', 'pages', '',
        'pages', 'pages', 'pages',
        jsonb_build_object('id', 'directory:', 'kind', 'directory', 'path', 'pages')
      )
    `;
    await transaction`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, logical_path,
        parent_path, sort_key, title, searchable_text, payload_json
      )
      SELECT ${knowledgeBaseId}, 'tree',
             'directory:group-' || lpad(value::text, 4, '0'),
             ${activeGenerationId},
             'tree/v1/' || lpad((value % 64)::text, 4, '0'),
             'pages/group-' || lpad(value::text, 4, '0'),
             'pages', 'group-' || lpad(value::text, 4, '0'),
             'Group ' || value, 'group ' || value,
             jsonb_build_object(
               'id', 'directory:group-' || lpad(value::text, 4, '0'),
               'kind', 'directory',
               'path', 'pages/group-' || lpad(value::text, 4, '0')
             )
      FROM generate_series(0, ${directoryCount - 1}) value
    `;
    await transaction`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, logical_path,
        parent_path, sort_key, title, searchable_text, payload_json
      )
      SELECT ${knowledgeBaseId}, 'tree',
             ${prefix} || '-source-' || lpad(value::text, 7, '0'),
             ${activeGenerationId},
             'tree/v1/' || lpad((value % 64)::text, 4, '0'),
             'pages/group-' || lpad(((value - 1) / 1000)::text, 4, '0')
               || '/document-' || lpad(value::text, 7, '0') || '.md',
             'pages/group-' || lpad(((value - 1) / 1000)::text, 4, '0'),
             'document-' || lpad(value::text, 7, '0'),
             'Document ' || value, 'domain neutral document ' || value,
             jsonb_build_object(
               'id', ${prefix} || '-source-' || lpad(value::text, 7, '0'),
               'kind', 'file',
               'path', 'pages/group-' || lpad(((value - 1) / 1000)::text, 4, '0')
                 || '/document-' || lpad(value::text, 7, '0') || '.md'
             )
      FROM generate_series(1, ${size}) value
    `;
    await transaction`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, logical_path,
        sort_key, title, searchable_text, payload_json
      )
      SELECT ${knowledgeBaseId}, 'graph_node',
             ${prefix} || '-node-' || lpad(value::text, 7, '0'),
             ${activeGenerationId},
             'graph_node/v1/' || lpad((value % 128)::text, 4, '0'),
             'pages/group-' || lpad(((value - 1) / 1000)::text, 4, '0')
               || '/document-' || lpad(value::text, 7, '0') || '.md',
             lpad(value::text, 7, '0'), 'Document ' || value,
             'domain neutral node ' || value,
             jsonb_build_object('kind', 'graph_node', 'ordinal', value)
      FROM generate_series(1, ${size}) value
    `;
    await transaction`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key,
        sort_key, title, searchable_text, payload_json
      )
      SELECT ${knowledgeBaseId}, 'graph_edge',
             ${prefix} || '-edge-' || lpad(value::text, 7, '0'),
             ${activeGenerationId},
             'graph_edge/v1/' || lpad((value % 128)::text, 4, '0'),
             lpad(value::text, 7, '0'), 'Related document',
             'domain neutral edge ' || value,
             jsonb_build_object('kind', 'graph_edge', 'ordinal', value)
      FROM generate_series(1, ${Math.max(0, size - 1)}) value
    `;
  });
  await sql.unsafe("ANALYZE focowiki.active_projection_records");
  return { knowledgeBaseId, targetGenerationId };
}

async function measureReadProbesUntilComplete(
  sql: ReturnType<typeof postgres>,
  knowledgeBaseId: string,
  operation: Promise<unknown>
) {
  let complete = false;
  void operation.then(
    () => {
      complete = true;
    },
    () => {
      complete = true;
    }
  );
  const adminDurations: number[] = [];
  const openapiDurations: number[] = [];
  await Promise.all(Array.from({ length: readProbeConcurrency }, async () => {
    do {
      const adminStartedAt = performance.now();
      await sql`
        SELECT active_generation_id, resource_revision
        FROM focowiki.knowledge_bases
        WHERE id = ${knowledgeBaseId} AND deleted_at IS NULL
      `;
      adminDurations.push(performance.now() - adminStartedAt);
      const openapiStartedAt = performance.now();
      await sql`
        SELECT record_id, logical_path, title
        FROM focowiki.active_projection_records
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND projection_kind = 'tree'
        ORDER BY record_id
        LIMIT 100
      `;
      openapiDurations.push(performance.now() - openapiStartedAt);
    } while (!complete || adminDurations.length < 20);
  }));
  return {
    adminReadP50Ms: percentile(adminDurations, 50),
    adminReadP95Ms: percentile(adminDurations, 95),
    openapiReadP50Ms: percentile(openapiDurations, 50),
    openapiReadP95Ms: percentile(openapiDurations, 95)
  };
}

async function readOutputCounts(
  sql: ReturnType<typeof postgres>,
  generationId: string
) {
  const rows = await sql<Array<{
    tree_count: number;
    directory_count: number;
    graph_node_count: number;
    graph_edge_count: number;
  }>>`
    SELECT
      count(*) FILTER (WHERE projection_kind = 'tree')::int AS tree_count,
      (SELECT count(*)::int
       FROM focowiki.generation_directory_navigation_summaries
       WHERE generation_id = ${generationId}) AS directory_count,
      count(*) FILTER (WHERE projection_kind = 'graph_node')::int AS graph_node_count,
      count(*) FILTER (WHERE projection_kind = 'graph_edge')::int AS graph_edge_count
    FROM focowiki.generation_projection_records
    WHERE generation_id = ${generationId}
  `;
  return {
    treeRecordCount: Number(rows[0]?.tree_count ?? 0),
    directoryCount: Number(rows[0]?.directory_count ?? 0),
    graphNodeCount: Number(rows[0]?.graph_node_count ?? 0),
    graphEdgeCount: Number(rows[0]?.graph_edge_count ?? 0)
  };
}

function result(
  phase: string,
  processedRecordCount: number,
  counts: Partial<{
    shardWrites: number;
    directoryWrites: number;
    rootWrites: number;
    objectReuses: number;
  }> = {}
) {
  return {
    phase,
    processedRecordCount,
    shardWrites: counts.shardWrites ?? 0,
    directoryWrites: counts.directoryWrites ?? 0,
    rootWrites: counts.rootWrites ?? 0,
    objectReuses: counts.objectReuses ?? 0
  };
}

function createQueryMetrics() {
  let total = 0;
  let byOperation: Record<string, number> = {};
  return {
    observe(query: string) {
      total += 1;
      const operation = query.trimStart().split(/\s+/u)[0]?.toUpperCase() ?? "UNKNOWN";
      byOperation[operation] = (byOperation[operation] ?? 0) + 1;
    },
    reset() {
      total = 0;
      byOperation = {};
    },
    get total() {
      return total;
    },
    get byOperation() {
      return { ...byOperation };
    }
  };
}

function createResourceSampler() {
  let timer: NodeJS.Timeout | null = null;
  let rssStartBytes = process.memoryUsage().rss;
  let rssPeakBytes = rssStartBytes;
  return {
    start() {
      rssStartBytes = process.memoryUsage().rss;
      rssPeakBytes = rssStartBytes;
      timer = setInterval(() => {
        rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
      }, resourceSampleIntervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
      return { rssStartBytes, rssPeakBytes };
    }
  };
}

function renderOptimizedMarkdown(report: BenchmarkReport): string {
  return `# 投影修复优化后结果

生成时间：${report.generatedAt}

${renderCaseTable(report.cases)}

修复由独立 worker 执行，树和图使用有界集合式批次，目录只写最终叶和根。测试期间并发执行 Admin 与 OpenAPI 读取探针。
`;
}

function renderComparisonMarkdown(
  baseline: BenchmarkReport,
  optimized: BenchmarkReport
): string {
  const rows = optimized.cases.map((current) => {
    const previous = baseline.cases.find((item) => item.size === current.size);
    return `| ${current.size.toLocaleString("en-US")} | ${previous?.durationMs ?? "n/a"} | `
      + `${current.durationMs} | ${
        previous ? `${round(previous.durationMs / current.durationMs)}x` : "n/a"
      } | `
      + `${previous?.sqlStatementCount ?? "n/a"} | ${current.sqlStatementCount} | `
      + `${current.readProbes.adminReadP95Ms} | ${current.readProbes.openapiReadP95Ms} | `
      + `${current.rssPeakBytes} |`;
  }).join("\n");
  return `# 投影修复优化前后对比

| 记录数 | 优化前 ms | 优化后 ms | 提升倍数 | 优化前 SQL | 优化后 SQL | Admin P95 ms | OpenAPI P95 ms | RSS 峰值 bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}

验收要求：30,000 条不超过 10 分钟，100,000 条不超过 30 分钟，吞吐提升至少 10 倍，读取 P95 不超过 200 ms，RSS 不超过 2 GiB。
`;
}

function renderCaseTable(cases: BenchmarkCase[]): string {
  const rows = cases.map((item) =>
    `| ${item.size.toLocaleString("en-US")} | ${item.durationMs} | `
    + `${item.recordsPerSecond} | ${item.sqlStatementCount} | `
    + `${item.logicalShardWriteCount} | ${item.logicalDirectoryWriteCount} | `
    + `${item.rssPeakBytes} | ${item.readProbes.adminReadP95Ms} | `
    + `${item.readProbes.openapiReadP95Ms} |`
  ).join("\n");
  return `| 记录数 | 总耗时 ms | 记录/秒 | SQL 数 | 分片逻辑写 | 目录逻辑写 | RSS 峰值 bytes | Admin P95 ms | OpenAPI P95 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}`;
}

function readFixtureSizes(): number[] {
  const configured = process.env.PROJECTION_REPAIR_BENCHMARK_SIZES;
  if (!configured) return [30_000, 100_000];
  const values = configured.split(",").map((value) => Number(value.trim()));
  if (
    values.length === 0
    || values.some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new Error("PROJECTION_REPAIR_BENCHMARK_SIZES must contain positive integers");
  }
  return values;
}

function loadLocalEnvironment(): void {
  const candidates = [resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")];
  const envFile = candidates.find((candidate) => existsSync(candidate));
  if (envFile) loadEnvFile(envFile);
}

function readDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

function databaseConnectionUrl(source: string, database: string): string {
  const url = new URL(source);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function percentile(values: number[], percentileValue: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1)
  );
  return round(ordered[index] ?? 0);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

type BenchmarkCase = {
  size: number;
  durationMs: number;
  recordsPerSecond: number;
  phaseDurationMs: Record<string, number>;
  subtaskCount?: number;
  sliceCount?: number;
  sqlStatementCount: number;
  sqlStatementsByOperation: Record<string, number>;
  logicalShardWriteCount: number;
  logicalDirectoryWriteCount: number;
  logicalRootWriteCount: number;
  logicalObjectReuseCount: number;
  retryCount: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssPeakBytes: number;
  rssGrowthBytes: number;
  eventLoopDelayP95Ms: number;
  readProbes: {
    adminReadP50Ms: number;
    adminReadP95Ms: number;
    openapiReadP50Ms: number;
    openapiReadP95Ms: number;
  };
  outputCounts: {
    treeRecordCount: number;
    directoryCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
  };
};

type BenchmarkReport = {
  schemaVersion: number;
  kind: string;
  generatedAt: string;
  implementation: {
    repairVersion: number;
    treeWriteMode: string;
    directoryWriteMode: string;
    graphCountMode: string;
    workerOwner: string;
  };
  environment: Record<string, unknown>;
  profile: Record<string, unknown>;
  cases: BenchmarkCase[];
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
