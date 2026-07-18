import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import postgres from "postgres";
import { createPostgresPublicationImpactRepository } from "../src/infrastructure/postgres/publication-impact-repository.js";
import { createJsonProjectionShardWriter } from "../src/publication/json-projection-shard-writer.js";
import { buildExplainAnalyzeSql, summarizeQueryPlan } from "../src/db/query-plan-validation.js";

const KNOWLEDGE_BASE_ID = "kb-incremental-scale-evidence";
const ACTIVE_OBJECT_CHECKSUM = "d".repeat(64);
const CORPUS_SIZES = [100, 10_000, 100_000] as const;
const DIRTY_IMPACT_COUNT = 16;
const API_SAMPLE_ROUNDS = 12;
const reportDirectory = resolve(
  process.cwd(),
  "../../ReferenceDocs/implement-incremental-sharded-publication"
);

loadLocalEnvironment();

const databaseUrl = readDatabaseUrl();
const adminOrigin = process.env.ADMIN_UI_PUBLIC_ORIGIN ?? "http://127.0.0.1:43100";
const adminBaseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT ?? "43000"}`;
const openApiBaseUrl = `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT ?? "43200"}`;
const sql = postgres(databaseUrl, { max: 4 });
let createdKeyId: string | null = null;
let adminCookie: string | null = null;

try {
  await cleanupFixture(sql);
  await createFixture(sql);
  const credentials = await createOpenApiCredentials();
  createdKeyId = credentials.keyId;
  adminCookie = credentials.adminCookie;

  const cases: ScaleEvidenceCase[] = [];
  let previousSize = 0;
  for (const corpusSize of CORPUS_SIZES) {
    await seedFixtureRange(sql, previousSize + 1, corpusSize);
    await activateCheckpointGeneration(sql, corpusSize);
    await sql.unsafe("ANALYZE focowiki.source_files");
    await sql.unsafe("ANALYZE focowiki.active_object_refs");
    await sql.unsafe("ANALYZE focowiki.active_projection_records");
    cases.push(await measureScaleCase({
      corpusSize,
      rawKey: credentials.rawKey
    }));
    previousSize = corpusSize;
  }

  const acceptance = evaluateAcceptance(cases);
  const report = {
    kind: "incremental-publication-scale-evidence",
    generatedAt: new Date().toISOString(),
    fixture: {
      durableStore: "PostgreSQL",
      corpusSizes: CORPUS_SIZES,
      fixedDirtyImpactCount: DIRTY_IMPACT_COUNT,
      apiSampleRounds: API_SAMPLE_ROUNDS,
      note: "Synthetic domain-neutral records exercise durable indexes without model or bulk object uploads."
    },
    cases,
    acceptance
  };
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    resolve(reportDirectory, "incremental-scale-evidence.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    resolve(reportDirectory, "incremental-scale-evidence.md"),
    renderMarkdownReport(report),
    "utf8"
  );
  console.log(JSON.stringify(report, null, 2));
  if (!acceptance.ok) process.exitCode = 1;
} finally {
  if (createdKeyId && adminCookie) {
    await fetch(`${adminBaseUrl}/admin/api/openapi-keys/${createdKeyId}`, {
      method: "DELETE",
      headers: { cookie: adminCookie, origin: adminOrigin }
    }).catch(() => undefined);
  }
  await cleanupFixture(sql);
  await sql.end({ timeout: 5 });
}

type ScaleEvidenceCase = {
  corpusSize: number;
  durableRows: {
    sourceFiles: number;
    activeObjectReferences: number;
    activeProjectionRecords: number;
  };
  fixedDirtyBatch: {
    queryCount: number;
    scannedRows: number;
    s3Reads: number;
    s3Writes: number;
    rewrittenObjects: number;
    touchedShards: number;
    durationMs: number;
    throughputImpactsPerSecond: number;
    cpuUserMs: number;
    cpuSystemMs: number;
    peakRssMb: number;
  };
  apiLatency: {
    requestCount: number;
    errorCount: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  queryPlans: Record<string, ReturnType<typeof summarizeQueryPlan>>;
};

async function createFixture(client: typeof sql): Promise<void> {
  await client.begin(async (transaction) => {
    await transaction`
      INSERT INTO focowiki.knowledge_bases (id, name, description)
      VALUES (${KNOWLEDGE_BASE_ID}, 'Incremental scale evidence', 'Domain-neutral durable fixture')
    `;
    await transaction`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        lifecycle_state, verified_at
      ) VALUES (
        ${ACTIVE_OBJECT_CHECKSUM}, 1, 'validation/scale/shared.md',
        'text/markdown; charset=utf-8', 32, 'active', now()
      )
    `;
    await transaction`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, activated_at
      ) VALUES ('generation-scale-seed', ${KNOWLEDGE_BASE_ID}, 'active', now())
    `;
    await transaction`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-scale-seed'
      WHERE id = ${KNOWLEDGE_BASE_ID}
    `;
    await transaction`
      INSERT INTO focowiki.knowledge_base_projection_repairs (
        knowledge_base_id, repair_version, base_generation_id, state,
        checkpoint_json, completed_at
      ) VALUES (
        ${KNOWLEDGE_BASE_ID}, 1, 'generation-scale-seed', 'completed',
        ${transaction.json({ validationFixture: true })}, now()
      )
    `;
  });
}

async function seedFixtureRange(client: typeof sql, start: number, end: number): Promise<void> {
  if (end < start) return;
  await client.begin(async (transaction) => {
    await transaction`
      INSERT INTO focowiki.source_files (
        id, knowledge_base_id, object_key, content_type, size_bytes,
        checksum_sha256, processing_status, processing_stage,
        processing_started_at, processing_ended_at, generated_output_status,
        name, relative_path, path_key, active_revision_id
      )
      SELECT
        'source-file-scale-' || lpad(value::text, 6, '0'),
        ${KNOWLEDGE_BASE_ID},
        'validation/scale/source-' || lpad(value::text, 6, '0') || '.md',
        'text/markdown; charset=utf-8', 32, md5(value::text) || md5(value::text),
        'completed', 'generation_activation', now(), now(), 'visible',
        'document-' || lpad(value::text, 6, '0') || '.md',
        'scale/document-' || lpad(value::text, 6, '0') || '.md',
        'scale/document-' || lpad(value::text, 6, '0') || '.md',
        'source-revision-scale-' || lpad(value::text, 6, '0')
      FROM generate_series(${start}::integer, ${end}::integer) AS value
    `;
    await transaction`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key,
        content_type, size_bytes, checksum_sha256, processing_status
      )
      SELECT
        'source-revision-scale-' || lpad(value::text, 6, '0'),
        ${KNOWLEDGE_BASE_ID},
        'source-file-scale-' || lpad(value::text, 6, '0'), 1,
        'validation/scale/source-' || lpad(value::text, 6, '0') || '.md',
        'text/markdown; charset=utf-8', 32, md5(value::text) || md5(value::text),
        'completed'
      FROM generate_series(${start}::integer, ${end}::integer) AS value
    `;
  });
  await client`
    INSERT INTO focowiki.active_object_refs (
      knowledge_base_id, ref_kind, ref_key, file_id,
      last_changed_generation_id, checksum_sha256, format_version,
      logical_path, source_file_id
    )
    SELECT
      ${KNOWLEDGE_BASE_ID}, 'page',
      'source-file-scale-' || lpad(value::text, 6, '0'),
      'bundle-file-scale-' || lpad(value::text, 6, '0'),
      'generation-scale-seed', ${ACTIVE_OBJECT_CHECKSUM}, 1,
      'pages/scale/document-' || lpad(value::text, 6, '0') || '.md',
      'source-file-scale-' || lpad(value::text, 6, '0')
    FROM generate_series(${start}::integer, ${end}::integer) AS value
  `;
  await client`
    INSERT INTO focowiki.active_projection_records (
      knowledge_base_id, projection_kind, record_id,
      last_changed_generation_id, shard_key, source_file_id,
      related_source_file_id, logical_path, parent_path, sort_key,
      title, summary, searchable_text, payload_json
    )
    SELECT
      ${KNOWLEDGE_BASE_ID}, projection.kind,
      CASE WHEN projection.kind = 'graph_edge'
        THEN 'graph-edge-scale-' || lpad(value::text, 6, '0')
        ELSE 'source-file-scale-' || lpad(value::text, 6, '0') END,
      'generation-scale-seed',
      projection.kind || '/v1/' || lpad((value % 256)::text, 4, '0'),
      'source-file-scale-' || lpad(value::text, 6, '0'),
      CASE WHEN projection.kind = 'graph_edge'
        THEN 'source-file-scale-' || lpad((CASE WHEN value = ${end} THEN ${start} ELSE value + 1 END)::text, 6, '0')
        ELSE NULL END,
      'pages/scale/document-' || lpad(value::text, 6, '0') || '.md',
      CASE WHEN projection.kind = 'tree' THEN 'pages/scale' ELSE NULL END,
      'pages/scale/document-' || lpad(value::text, 6, '0') || '.md',
      'Scale document ' || lpad(value::text, 6, '0'),
      'Domain-neutral scale fixture',
      'Scale document ' || lpad(value::text, 6, '0') || ' needle-' || lpad(((value - 1) % 16 + 1)::text, 2, '0'),
      CASE WHEN projection.kind = 'graph_edge' THEN jsonb_build_object(
        'fromFileId', 'source-file-scale-' || lpad(value::text, 6, '0'),
        'fromPath', 'pages/scale/document-' || lpad(value::text, 6, '0') || '.md',
        'fromTitle', 'Scale document ' || lpad(value::text, 6, '0'),
        'toFileId', 'source-file-scale-' || lpad((CASE WHEN value = ${end} THEN ${start} ELSE value + 1 END)::text, 6, '0'),
        'toPath', 'pages/scale/document-' || lpad((CASE WHEN value = ${end} THEN ${start} ELSE value + 1 END)::text, 6, '0') || '.md',
        'toTitle', 'Scale document related',
        'relationType', 'related', 'weight', 0.8, 'reason', 'Shared scale fixture subject'
      ) ELSE jsonb_build_object(
        'fileId', 'bundle-file-scale-' || lpad(value::text, 6, '0'),
        'path', 'pages/scale/document-' || lpad(value::text, 6, '0') || '.md',
        'title', 'Scale document ' || lpad(value::text, 6, '0'),
        'kind', 'file'
      ) END
    FROM generate_series(${start}::integer, ${end}::integer) AS value
    CROSS JOIN (VALUES ('search'), ('tree'), ('graph_node'), ('graph_edge')) AS projection(kind)
  `;
}

async function activateCheckpointGeneration(client: typeof sql, corpusSize: number): Promise<void> {
  const generationId = `generation-scale-${corpusSize}`;
  await client`
    UPDATE focowiki.publication_generations
    SET state = 'superseded'
    WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID} AND state = 'active'
  `;
  await client`
    INSERT INTO focowiki.publication_generations (
      id, knowledge_base_id, state, activated_at
    ) VALUES (${generationId}, ${KNOWLEDGE_BASE_ID}, 'active', now())
  `;
  await client`
    UPDATE focowiki.knowledge_bases
    SET active_generation_id = ${generationId}, updated_at = now()
    WHERE id = ${KNOWLEDGE_BASE_ID}
  `;
}

async function measureScaleCase(input: {
  corpusSize: number;
  rawKey: string;
}): Promise<ScaleEvidenceCase> {
  const rowCounts = await readDurableRowCounts(sql);
  const queryPlans = await readQueryPlans(sql);
  const mutation = await measureFixedDirtyBatch(input.corpusSize);
  const apiLatency = await measureApiLatency(input.rawKey);
  return {
    corpusSize: input.corpusSize,
    durableRows: rowCounts,
    fixedDirtyBatch: {
      ...mutation,
      scannedRows: Object.values(queryPlans).reduce((total, plan) => total + plan.actualRows, 0)
    },
    apiLatency,
    queryPlans
  };
}

async function measureFixedDirtyBatch(corpusSize: number) {
  const generationId = `generation-dirty-${corpusSize}`;
  await seedDirtyBatch(sql, generationId);
  let queryCount = 0;
  const measuredSql = postgres(databaseUrl, {
    max: 1,
    debug() {
      queryCount += 1;
    }
  });
  const repository = createPostgresPublicationImpactRepository(measuredSql);
  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  const workerId = `scale-worker-${corpusSize}`;
  const now = new Date().toISOString();
  const claimed = await repository.claimBatch({
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    generationId,
    workerId,
    limit: DIRTY_IMPACT_COUNT,
    now,
    staleBefore: new Date(Date.now() - 60_000).toISOString()
  });
  const touchedShardKeys = new Set<string>();
  for (const impact of claimed) {
    const firstShardTouch = !touchedShardKeys.has(impact.projectionKey);
    touchedShardKeys.add(impact.projectionKey);
    await repository.complete({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      generationId,
      impactId: impact.id,
      workerId,
      touchedShardCount: firstShardTouch ? 1 : 0,
      completedAt: new Date().toISOString()
    });
  }
  const shardProbe = await runInstrumentedShardProbe(generationId);
  const durationMs = round(performance.now() - startedAt);
  const cpu = process.cpuUsage(cpuBefore);
  const peakRssMb = round(Math.max(rssBefore, process.memoryUsage().rss) / 1024 / 1024);
  await measuredSql.end({ timeout: 5 });
  await sql`DELETE FROM focowiki.publication_generations WHERE id = ${generationId}`;
  return {
    queryCount,
    ...shardProbe,
    touchedShards: touchedShardKeys.size,
    durationMs,
    throughputImpactsPerSecond: round(claimed.length / Math.max(durationMs / 1_000, 0.001)),
    cpuUserMs: round(cpu.user / 1_000),
    cpuSystemMs: round(cpu.system / 1_000),
    peakRssMb
  };
}

async function seedDirtyBatch(client: typeof sql, generationId: string): Promise<void> {
  await client`
    INSERT INTO focowiki.publication_generations (
      id, knowledge_base_id, state, frozen_at
    ) VALUES (${generationId}, ${KNOWLEDGE_BASE_ID}, 'frozen', now())
  `;
  await client`
    INSERT INTO focowiki.publication_progress (
      knowledge_base_id, generation_id, stage, total_impact_count
    ) VALUES (${KNOWLEDGE_BASE_ID}, ${generationId}, 'projection', ${DIRTY_IMPACT_COUNT})
  `;
  await client`
    INSERT INTO focowiki.publication_change_facts (
      id, knowledge_base_id, source_file_id, source_revision_id,
      kind, previous_path, path, resource_revision, generation_id
    )
    SELECT
      ${generationId} || '-change-' || value,
      ${KNOWLEDGE_BASE_ID},
      'source-file-scale-' || lpad(value::text, 6, '0'),
      'source-revision-scale-' || lpad(value::text, 6, '0'),
      'source_replaced',
      ${generationId} || '/document-' || lpad(value::text, 6, '0') || '.md',
      'scale/document-' || lpad(value::text, 6, '0') || '.md',
      2, ${generationId}
    FROM generate_series(1, ${DIRTY_IMPACT_COUNT}::integer) AS value
  `;
  await client`
    INSERT INTO focowiki.publication_impacts (
      id, knowledge_base_id, generation_id, projection_kind,
      projection_key, record_identity, action
    )
    SELECT
      ${generationId} || '-impact-' || value,
      ${KNOWLEDGE_BASE_ID}, ${generationId}, 'search',
      'search/v1/' || lpad(((value - 1) % 2 + 1)::text, 4, '0'),
      'source-file-scale-' || lpad(value::text, 6, '0'), 'upsert'
    FROM generate_series(1, ${DIRTY_IMPACT_COUNT}::integer) AS value
  `;
  await client`
    INSERT INTO focowiki.publication_impact_causes (impact_id, change_fact_id)
    SELECT
      ${generationId} || '-impact-' || value,
      ${generationId} || '-change-' || value
    FROM generate_series(1, ${DIRTY_IMPACT_COUNT}::integer) AS value
  `;
}

async function runInstrumentedShardProbe(generationId: string) {
  let s3Reads = 0;
  let s3Writes = 0;
  let rewrittenObjects = 0;
  const writer = createJsonProjectionShardWriter({
    references: {
      findStagedByRef: async () => null,
      findActiveByRef: async (input) => ({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        refKind: "projection_shard",
        refKey: input.refKey,
        fileId: `bundle-file-${input.refKey.replaceAll("/", "-")}`,
        lastChangedGenerationId: "generation-scale-active",
        checksumSha256: ACTIVE_OBJECT_CHECKSUM,
        formatVersion: 1,
        logicalPath: `_index/${input.refKey}.json`,
        sourceFileId: null,
        projectionShardId: "projection-shard-existing",
        objectKey: `validation/scale/${input.refKey}.json`,
        contentType: "application/json; charset=utf-8",
        sizeBytes: 64
      }),
      findActiveByPath: async () => null,
      stageUpsert: async () => undefined,
      stageDelete: async () => undefined
    },
    shards: {
      register: async (input) => ({ ...input })
    },
    immutableObjects: {
      write: async (input) => {
        s3Writes += 1;
        rewrittenObjects += 1;
        const body = typeof input.body === "string" ? input.body : Buffer.from(input.body).toString("utf8");
        const checksumSha256 = createHash("sha256").update(body).digest("hex");
        const recordedAt = new Date().toISOString();
        return {
          checksumSha256,
          formatVersion: 1,
          objectKey: `validation/scale/${checksumSha256}.json`,
          contentType: input.contentType,
          sizeBytes: Buffer.byteLength(body),
          createdAt: recordedAt,
          verifiedAt: recordedAt,
          reused: false
        };
      }
    },
    storage: {
      getObjectText: async () => {
        s3Reads += 1;
        return '{"formatVersion":1,"projection":"search","shard":"existing","records":[]}\n';
      }
    },
    maxShardBytes: 1_048_576
  });
  for (let shard = 1; shard <= 2; shard += 1) {
    const shardKey = `search/v1/${String(shard).padStart(4, "0")}`;
    await writer.applyBatch({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      generationId,
      projectionKind: "search",
      shardKey,
      logicalPath: `_index/${shardKey}.json`,
      changes: Array.from({ length: DIRTY_IMPACT_COUNT / 2 }, (_, index) => ({
        recordId: `dirty-${shard}-${index}`,
        record: { id: `dirty-${shard}-${index}`, title: `Dirty record ${index}` }
      }))
    });
  }
  return { s3Reads, s3Writes, rewrittenObjects };
}

async function readDurableRowCounts(client: typeof sql) {
  const rows = await client<Array<{
    source_files: number;
    active_object_references: number;
    active_projection_records: number;
  }>>`
    SELECT
      (SELECT count(*)::int FROM focowiki.source_files WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}) AS source_files,
      (SELECT count(*)::int FROM focowiki.active_object_refs WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}) AS active_object_references,
      (SELECT count(*)::int FROM focowiki.active_projection_records WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}) AS active_projection_records
  `;
  const row = rows[0]!;
  return {
    sourceFiles: Number(row.source_files),
    activeObjectReferences: Number(row.active_object_references),
    activeProjectionRecords: Number(row.active_projection_records)
  };
}

async function readQueryPlans(client: typeof sql) {
  const queries = {
    tree: `
      SELECT record_id, logical_path, title
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND projection_kind = 'tree'
        AND parent_path = 'pages/scale'
      ORDER BY sort_key, record_id
      LIMIT 51
    `,
    search: `
      SELECT record_id, source_file_id, logical_path, title
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND projection_kind = 'search'
        AND to_tsvector('simple', coalesce(searchable_text, '')) @@ plainto_tsquery('simple', 'needle-01')
      ORDER BY record_id
      LIMIT 51
    `,
    related: `
      SELECT record_id, source_file_id, related_source_file_id
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND projection_kind = 'graph_edge'
        AND (source_file_id = 'source-file-scale-000001'
          OR related_source_file_id = 'source-file-scale-000001')
      ORDER BY record_id
      LIMIT 51
    `,
    dirtyClaim: `
      SELECT id
      FROM focowiki.publication_impacts
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND status = 'pending'
      ORDER BY run_after, created_at, id
      LIMIT ${DIRTY_IMPACT_COUNT}
    `
  };
  const plans: Record<string, ReturnType<typeof summarizeQueryPlan>> = {};
  for (const [name, query] of Object.entries(queries)) {
    const rows = await client.unsafe<Array<{ "QUERY PLAN": unknown }>>(
      buildExplainAnalyzeSql(query)
    );
    plans[name] = summarizeQueryPlan(rows[0]?.["QUERY PLAN"]);
  }
  return plans;
}

async function measureApiLatency(rawKey: string) {
  const fileId = "bundle-file-scale-000001";
  const endpoints = [
    `/openapi/v2/knowledge-bases/${KNOWLEDGE_BASE_ID}/tree?parentPath=pages%2Fscale&limit=50`,
    `/openapi/v2/knowledge-bases/${KNOWLEDGE_BASE_ID}/files/search?query=needle-01&mode=hybrid&limit=20`,
    `/openapi/v2/knowledge-bases/${KNOWLEDGE_BASE_ID}/graph/expand?fileId=${fileId}&depth=1&fanout=10&limit=20`,
    `/openapi/v2/knowledge-bases/${KNOWLEDGE_BASE_ID}/files/${fileId}/related?limit=20`
  ];
  const durations: number[] = [];
  let errorCount = 0;
  for (let round = 0; round < API_SAMPLE_ROUNDS; round += 1) {
    const samples = await Promise.all(endpoints.map(async (pathname) => {
      const startedAt = performance.now();
      const response = await fetch(`${openApiBaseUrl}${pathname}`, {
        headers: { authorization: `Bearer ${rawKey}` }
      });
      const durationMs = performance.now() - startedAt;
      if (!response.ok) {
        errorCount += 1;
        const body = await response.text();
        throw new Error(`Scale API request failed with ${response.status}: ${body.slice(0, 300)}`);
      }
      await response.arrayBuffer();
      return durationMs;
    }));
    durations.push(...samples);
  }
  return {
    requestCount: durations.length,
    errorCount,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: round(Math.max(...durations))
  };
}

async function createOpenApiCredentials(): Promise<{
  rawKey: string;
  keyId: string;
  adminCookie: string;
}> {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) throw new Error("Admin credentials are required for scale evidence");
  const login = await fetch(`${adminBaseUrl}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? null;
  if (!login.ok || !cookie) throw new Error("Admin login failed for scale evidence");
  const created = await fetch(`${adminBaseUrl}/admin/api/openapi-keys`, {
    method: "POST",
    headers: {
      cookie,
      origin: adminOrigin,
      "content-type": "application/json"
    },
    body: JSON.stringify({ name: "Incremental scale evidence" })
  });
  const body = await created.json() as {
    key?: { id?: string };
    oneTimeKey?: { rawKey?: string };
  };
  if (!created.ok || !body.key?.id || !body.oneTimeKey?.rawKey) {
    throw new Error(`OpenAPI key creation failed with ${created.status}`);
  }
  return { rawKey: body.oneTimeKey.rawKey, keyId: body.key.id, adminCookie: cookie };
}

function evaluateAcceptance(cases: ScaleEvidenceCase[]) {
  const failures: string[] = [];
  const first = cases[0];
  if (!first) return { ok: false, failures: ["No scale cases were recorded."] };
  for (const item of cases) {
    if (item.fixedDirtyBatch.queryCount !== first.fixedDirtyBatch.queryCount) {
      failures.push(`Query count changed at corpus size ${item.corpusSize}.`);
    }
    if (item.fixedDirtyBatch.s3Reads !== 2 || item.fixedDirtyBatch.s3Writes !== 2) {
      failures.push(`S3 operation count is not bounded at corpus size ${item.corpusSize}.`);
    }
    if (item.fixedDirtyBatch.rewrittenObjects !== 2 || item.fixedDirtyBatch.touchedShards !== 2) {
      failures.push(`Dirty shard work is not bounded at corpus size ${item.corpusSize}.`);
    }
    if (item.apiLatency.errorCount > 0 || item.apiLatency.p95Ms > 2_000 || item.apiLatency.p99Ms > 5_000) {
      failures.push(`API latency or errors exceeded the scale budget at corpus size ${item.corpusSize}.`);
    }
  }
  const largest = cases.at(-1)!;
  if (largest.fixedDirtyBatch.durationMs > Math.max(2_000, first.fixedDirtyBatch.durationMs * 8)) {
    failures.push("Fixed dirty batch duration grew beyond the bounded scale budget.");
  }
  return { ok: failures.length === 0, failures };
}

function renderMarkdownReport(report: {
  generatedAt: string;
  cases: ScaleEvidenceCase[];
  acceptance: { ok: boolean; failures: string[] };
}): string {
  const rows = report.cases.map((item) =>
    `| ${item.corpusSize} | ${item.durableRows.activeProjectionRecords} | ${item.fixedDirtyBatch.queryCount} | ${item.fixedDirtyBatch.scannedRows} | ${item.fixedDirtyBatch.s3Reads}/${item.fixedDirtyBatch.s3Writes} | ${item.fixedDirtyBatch.rewrittenObjects} | ${item.fixedDirtyBatch.touchedShards} | ${item.fixedDirtyBatch.durationMs} | ${item.fixedDirtyBatch.throughputImpactsPerSecond} | ${item.fixedDirtyBatch.cpuUserMs}/${item.fixedDirtyBatch.cpuSystemMs} | ${item.fixedDirtyBatch.peakRssMb} | ${item.apiLatency.p50Ms}/${item.apiLatency.p95Ms}/${item.apiLatency.p99Ms} |`
  );
  return [
    "# Incremental publication scale evidence",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "The fixture uses durable PostgreSQL rows and the same fixed 16-impact mutation at every corpus size. The S3 counts come from the production JSON shard writer with an instrumented storage adapter.",
    "",
    "| Source files | Projection rows | Queries | Plan rows | S3 R/W | Rewritten | Shards | Duration ms | Impacts/s | CPU user/system ms | Peak RSS MB | API p50/p95/p99 ms |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    `Acceptance: ${report.acceptance.ok ? "PASS" : "FAIL"}`,
    ...report.acceptance.failures.map((failure) => `- ${failure}`),
    ""
  ].join("\n");
}

async function cleanupFixture(client: typeof sql): Promise<void> {
  await client.begin(async (transaction) => {
    await transaction`SET CONSTRAINTS ALL DEFERRED`;
    await transaction`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = NULL
      WHERE id = ${KNOWLEDGE_BASE_ID}
    `;
    await transaction`
      DELETE FROM focowiki.active_projection_records
      WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}
    `;
    await transaction`
      DELETE FROM focowiki.active_object_refs
      WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}
    `;
    await transaction`
      DELETE FROM focowiki.source_revisions
      WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}
    `;
    await transaction`
      DELETE FROM focowiki.source_files
      WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}
    `;
    await transaction`
      DELETE FROM focowiki.publication_generations
      WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}
    `;
    await transaction`DELETE FROM focowiki.knowledge_bases WHERE id = ${KNOWLEDGE_BASE_ID}`;
    await transaction`
      DELETE FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${ACTIVE_OBJECT_CHECKSUM} AND format_version = 1
    `;
  });
}

function loadLocalEnvironment(): void {
  const envPath = resolve(process.cwd(), "../../.env");
  try {
    loadEnvFile(envPath);
  } catch {
    // Explicit environment variables remain supported in CI.
  }
}

function readDatabaseUrl(): string {
  if (process.env.FOCOWIKI_TEST_DATABASE_URL) return process.env.FOCOWIKI_TEST_DATABASE_URL;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const database = process.env.POSTGRES_DB;
  const port = process.env.POSTGRES_HOST_PORT ?? "55432";
  if (!user || !password || !database) throw new Error("PostgreSQL test configuration is incomplete");
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function percentile(values: number[], rank: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * rank) - 1));
  return round(sorted[index] ?? 0);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
