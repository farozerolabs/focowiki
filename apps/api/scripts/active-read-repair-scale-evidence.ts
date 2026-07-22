import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import postgres from "postgres";
import { applyMigrations } from "../src/db/migrations.js";
import {
  buildExplainAnalyzeSql,
  summarizeQueryPlan,
  type QueryPlanSummary
} from "../src/db/query-plan-validation.js";
import { searchActiveProjections } from "../src/infrastructure/postgres/active-projection-search.js";

const fixtureSizes = [10_000, 100_000] as const;
const iterations = 8;
const reportDirectory = resolve(
  process.cwd(),
  "../../ReferenceDocs/repair-production-read-and-projection-defects"
);

loadLocalEnvironment();
const sourceDatabaseUrl = readDatabaseUrl();
const databaseName = `focowiki_read_repair_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const admin = postgres(databaseConnectionUrl(sourceDatabaseUrl, "postgres"), { max: 1 });
const sql = postgres(databaseConnectionUrl(sourceDatabaseUrl, databaseName), { max: 20 });

async function main(): Promise<void> {
  try {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
    for (const size of fixtureSizes) await seedFixture(size);
    const queryPlans = await measurePlans(100_000);
    const cases = [];
    for (const size of fixtureSizes) cases.push(await measureFixture(size));
    const report = {
      kind: "active-read-repair-scale-evidence",
      generatedAt: new Date().toISOString(),
      fixture: {
        recordCounts: fixtureSizes,
        seedMethod: "PostgreSQL generate_series",
        apiProcessCorpusMaterialization: false,
        iterations
      },
      queryPlans,
      cases,
      acceptance: evaluateAcceptance(queryPlans, cases)
    };
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(
      resolve(reportDirectory, "active-read-scale-evidence.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      resolve(reportDirectory, "active-read-scale-evidence.md"),
      renderMarkdown(report),
      "utf8"
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.acceptance.ok) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}

async function seedFixture(size: number): Promise<void> {
  const knowledgeBaseId = knowledgeBaseIdFor(size);
  const generationId = generationIdFor(size);
  const prefix = `scale-${size}`;
  const checksum = size === 10_000 ? "a".repeat(64) : "b".repeat(64);
  await sql.begin(async (transaction) => {
    await transaction`SET CONSTRAINTS ALL DEFERRED`;
    await transaction`
      INSERT INTO focowiki.knowledge_bases (id, name, description)
      VALUES (${knowledgeBaseId}, ${`Scale fixture ${size}`}, 'Domain-neutral search fixture')
    `;
    await transaction`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, generation_kind, activated_at
      ) VALUES (${generationId}, ${knowledgeBaseId}, 'active', 'normal', now())
    `;
    await transaction`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${generationId}
      WHERE id = ${knowledgeBaseId}
    `;
    await transaction`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type,
        size_bytes, lifecycle_state, verified_at
      ) VALUES (
        ${checksum}, 1, ${`${prefix}/shared.md`},
        'text/markdown; charset=utf-8', 64, 'active', now()
      )
    `;
    await transaction`
      INSERT INTO focowiki.source_files (
        id, knowledge_base_id, object_key, content_type, size_bytes,
        checksum_sha256, processing_status, processing_stage,
        generated_output_status, name, relative_path, path_key,
        active_revision_id
      )
      SELECT ${prefix} || '-source-' || lpad(value::text, 6, '0'),
             ${knowledgeBaseId}, ${prefix} || '/source/' || value || '.md',
             'text/markdown', 64, ${checksum}, 'completed',
             'generation_activation', 'visible',
             'document-' || lpad(value::text, 6, '0') || '.md',
             'group-' || lpad(((value - 1) / 1000)::text, 3, '0') ||
               '/document-' || lpad(value::text, 6, '0') || '.md',
             'group-' || lpad(((value - 1) / 1000)::text, 3, '0') ||
               '/document-' || lpad(value::text, 6, '0') || '.md',
             ${prefix} || '-revision-' || lpad(value::text, 6, '0')
      FROM generate_series(1, ${size}) value
    `;
    await transaction`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key,
        content_type, size_bytes, checksum_sha256, processing_status
      )
      SELECT ${prefix} || '-revision-' || lpad(value::text, 6, '0'),
             ${knowledgeBaseId},
             ${prefix} || '-source-' || lpad(value::text, 6, '0'),
             1, ${prefix} || '/source/' || value || '.md',
             'text/markdown', 64, ${checksum}, 'completed'
      FROM generate_series(1, ${size}) value
    `;
    await transaction`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version,
        logical_path, source_file_id
      )
      SELECT ${knowledgeBaseId}, 'page',
             ${prefix} || '-source-' || lpad(value::text, 6, '0'),
             ${prefix} || '-file-' || lpad(value::text, 6, '0'),
             ${generationId}, ${checksum}, 1,
             'pages/group-' || lpad(((value - 1) / 1000)::text, 3, '0') ||
               '/document-' || lpad(value::text, 6, '0') || '.md',
             ${prefix} || '-source-' || lpad(value::text, 6, '0')
      FROM generate_series(1, ${size}) value
    `;
    await transaction`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, source_file_id,
        logical_path, sort_key, title, summary, searchable_text, payload_json
      )
      SELECT ${knowledgeBaseId}, kind,
             ${prefix} || '-source-' || lpad(value::text, 6, '0'),
             ${generationId}, kind || '/v1/' || lpad((value % 64)::text, 4, '0'),
             ${prefix} || '-source-' || lpad(value::text, 6, '0'),
             'pages/group-' || lpad(((value - 1) / 1000)::text, 3, '0') ||
               '/document-' || lpad(value::text, 6, '0') || '.md',
             lpad(value::text, 6, '0'),
             CASE WHEN value % 10000 = 0 THEN 'Exact Handbook'
               ELSE 'Document ' || lpad(value::text, 6, '0') END,
             'Generated domain-neutral summary',
             CASE WHEN value % 10 = 0
               THEN 'shared policy topic common evidence exact handbook'
               ELSE 'document reference rare-signal-' || lpad(value::text, 6, '0') END,
             jsonb_build_object(
               'kind', kind,
               'fileKind', 'page',
               'path', 'pages/group-' || lpad(((value - 1) / 1000)::text, 3, '0') ||
                 '/document-' || lpad(value::text, 6, '0') || '.md'
             )
      FROM generate_series(1, ${size}) value
      CROSS JOIN (VALUES ('search'), ('graph_node')) projection(kind)
    `;
    await transaction`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, source_file_id,
        related_source_file_id, sort_key, title, summary,
        searchable_text, payload_json
      )
      SELECT ${knowledgeBaseId}, 'graph_edge',
             ${prefix} || '-edge-' || lpad(value::text, 6, '0'),
             ${generationId}, 'graph_edge/v1/' || lpad((value % 128)::text, 4, '0'),
             ${prefix} || '-source-' || lpad(value::text, 6, '0'),
             ${prefix} || '-source-' || lpad((value + 1)::text, 6, '0'),
             lpad(value::text, 6, '0'), 'Related document',
             'Adjacent deterministic relationship',
             CASE WHEN value % 10 = 0 THEN 'shared policy topic relationship'
               ELSE 'relationship rare-signal-' || lpad(value::text, 6, '0') END,
             jsonb_build_object(
               'kind', 'graph_edge',
               'fromTitle', 'Document ' || lpad(value::text, 6, '0'),
               'toTitle', 'Document ' || lpad((value + 1)::text, 6, '0')
             )
      FROM generate_series(1, ${size - 1}) value
    `;
    await transaction`
      INSERT INTO focowiki.generation_graph_summaries (
        knowledge_base_id, generation_id, node_count, edge_count,
        graph_index_available
      ) VALUES (${knowledgeBaseId}, ${generationId}, ${size}, ${size - 1}, true)
    `;
  });
  await sql.unsafe(`ANALYZE focowiki.source_files`);
  await sql.unsafe(`ANALYZE focowiki.active_object_refs`);
  await sql.unsafe(`ANALYZE focowiki.active_projection_records`);
}

async function measureFixture(size: number) {
  const knowledgeBaseId = knowledgeBaseIdFor(size);
  const generationId = generationIdFor(size);
  const scenarios = [
    { name: "exact-file", query: "Exact Handbook", mode: "file" as const },
    { name: "broad-file", query: "shared policy", mode: "file" as const },
    { name: "broad-graph", query: "shared policy", mode: "graph" as const },
    { name: "broad-hybrid", query: "shared policy", mode: "hybrid" as const },
    { name: "multi-term-fallback", query: "common evidence", mode: "hybrid" as const },
    { name: "empty", query: "missing-token-never-present", mode: "hybrid" as const }
  ];
  const measurements = [];
  for (const scenario of scenarios) {
    measurements.push(await measureScenario({
      ...scenario,
      knowledgeBaseId,
      generationId
    }));
  }
  const firstPage = await searchActiveProjections({
    sql,
    knowledgeBaseId,
    generationId,
    query: "shared policy",
    mode: "hybrid",
    limit: 50,
    cursor: null
  });
  const continuation = firstPage.nextCursor
    ? await measureScenario({
        name: "broad-hybrid-continuation",
        query: "shared policy",
        mode: "hybrid",
        knowledgeBaseId,
        generationId,
        cursor: firstPage.nextCursor
      })
    : null;
  const baseline = await measureLegacyBroadOr(knowledgeBaseId);
  const sessions = await countDatabaseSessions();
  const concurrent = await measureConcurrentSearch({ knowledgeBaseId, generationId });
  return { size, baseline, measurements, continuation, concurrent, sessions };
}

async function measureScenario(input: {
  name: string;
  knowledgeBaseId: string;
  generationId: string;
  query: string;
  mode: "file" | "graph" | "hybrid";
  cursor?: { score: number; recordId: string } | null;
}) {
  return measureOperation(input.name, async () => {
    const page = await searchActiveProjections({
      sql,
      knowledgeBaseId: input.knowledgeBaseId,
      generationId: input.generationId,
      query: input.query,
      mode: input.mode,
      limit: 50,
      cursor: input.cursor ?? null
    });
    return page.items.map((item) => `${item.recordId}:${item.score ?? 0}`);
  });
}

async function measureLegacyBroadOr(knowledgeBaseId: string) {
  return measureOperation("legacy-broad-or", async () => {
    const rows = await sql<Array<{ record_id: string }>>`
      SELECT record.record_id
      FROM focowiki.active_projection_records record
      WHERE record.knowledge_base_id = ${knowledgeBaseId}
        AND record.projection_kind = 'search'
        AND (
          to_tsvector('simple', coalesce(record.searchable_text, ''))
            @@ plainto_tsquery('simple', 'shared policy')
          OR lower(coalesce(record.searchable_text, '')) LIKE '%shared policy%'
        )
      ORDER BY focowiki.similarity(
        lower(coalesce(record.searchable_text, '')),
        'shared policy'
      ) DESC, record.record_id
      LIMIT 50
    `;
    return rows.map((row) => row.record_id);
  });
}

async function measureOperation(name: string, operation: () => Promise<string[]>) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  const durations: number[] = [];
  const orders: string[] = [];
  let errors = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    try {
      orders.push((await operation()).join("|"));
    } catch {
      errors += 1;
    }
    durations.push(performance.now() - startedAt);
  }
  const cpu = process.cpuUsage(cpuBefore);
  histogram.disable();
  return {
    name,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: round(Math.max(...durations)),
    throughputPerSecond: round(iterations / (durations.reduce((sum, value) => sum + value, 0) / 1000)),
    cpuUserMs: round(cpu.user / 1000),
    cpuSystemMs: round(cpu.system / 1000),
    rssGrowthMb: round((process.memoryUsage().rss - rssBefore) / 1024 / 1024),
    eventLoopDelayMaxMs: round(histogram.max / 1_000_000),
    errors,
    deterministicOrder: new Set(orders).size <= 1,
    resultCount: orders[0] ? orders[0].split("|").length : 0
  };
}

async function measureConcurrentSearch(input: {
  knowledgeBaseId: string;
  generationId: string;
}) {
  const startedAt = performance.now();
  const results = await Promise.allSettled(Array.from({ length: 16 }, () =>
    searchActiveProjections({
      sql,
      knowledgeBaseId: input.knowledgeBaseId,
      generationId: input.generationId,
      query: "shared policy",
      mode: "hybrid",
      limit: 50,
      cursor: null
    })
  ));
  return {
    concurrency: 16,
    durationMs: round(performance.now() - startedAt),
    errors: results.filter((result) => result.status === "rejected").length,
    resultCounts: results.map((result) =>
      result.status === "fulfilled" ? result.value.items.length : 0
    )
  };
}

async function measurePlans(size: number): Promise<Record<string, QueryPlanSummary>> {
  const knowledgeBaseId = knowledgeBaseIdFor(size);
  const cases = {
    exactTitle: `
      SELECT record_id FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${knowledgeBaseId}'
        AND projection_kind = 'search'
        AND lower(coalesce(title, '')) = lower('Exact Handbook')
      ORDER BY record_id LIMIT 501
    `,
    fullTextBroad: `
      SELECT record_id FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${knowledgeBaseId}'
        AND projection_kind = 'search'
        AND to_tsvector('simple', coalesce(searchable_text, ''))
          @@ plainto_tsquery('simple', 'shared policy')
      ORDER BY ts_rank_cd(
        to_tsvector('simple', coalesce(searchable_text, '')),
        plainto_tsquery('simple', 'shared policy')
      ) DESC, record_id LIMIT 501
    `,
    trigramBroad: `
      SELECT record_id FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${knowledgeBaseId}'
        AND projection_kind = 'search'
        AND lower(coalesce(searchable_text, '')) LIKE '%shared policy%'
      ORDER BY focowiki.similarity(lower(coalesce(searchable_text, '')), 'shared policy') DESC,
               record_id LIMIT 501
    `,
    legacyBroadOr: `
      SELECT record_id FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${knowledgeBaseId}'
        AND projection_kind = 'search'
        AND (
          to_tsvector('simple', coalesce(searchable_text, ''))
            @@ plainto_tsquery('simple', 'shared policy')
          OR lower(coalesce(searchable_text, '')) LIKE '%shared policy%'
        )
      ORDER BY focowiki.similarity(lower(coalesce(searchable_text, '')), 'shared policy') DESC,
               record_id LIMIT 501
    `
  };
  const plans: Record<string, QueryPlanSummary> = {};
  for (const [name, query] of Object.entries(cases)) {
    const rows = await sql.unsafe<Array<{ "QUERY PLAN": unknown }>>(
      buildExplainAnalyzeSql(query)
    );
    plans[name] = summarizeQueryPlan(rows[0]?.["QUERY PLAN"]);
  }
  return plans;
}

async function countDatabaseSessions(): Promise<number> {
  const rows = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS count
    FROM pg_stat_activity
    WHERE datname = current_database()
  `;
  return Number(rows[0]?.count ?? 0);
}

function evaluateAcceptance(
  plans: Record<string, QueryPlanSummary>,
  cases: Awaited<ReturnType<typeof measureFixture>>[]
) {
  const failures: string[] = [];
  for (const name of ["exactTitle", "fullTextBroad", "trigramBroad"]) {
    const plan = plans[name];
    if (!plan || plan.indexNames.length === 0) failures.push(`${name} did not use an index.`);
    if ((plan?.executionTimeMs ?? Number.POSITIVE_INFINITY) > 2_000) {
      failures.push(`${name} exceeded the 2000 ms plan budget.`);
    }
  }
  for (const fixture of cases) {
    for (const measurement of fixture.measurements) {
      if (measurement.errors > 0) failures.push(`${fixture.size}:${measurement.name} returned errors.`);
      if (!measurement.deterministicOrder) {
        failures.push(`${fixture.size}:${measurement.name} returned unstable ordering.`);
      }
      if (measurement.p95Ms > 2_000) {
        failures.push(`${fixture.size}:${measurement.name} exceeded the 2000 ms p95 budget.`);
      }
      if (measurement.rssGrowthMb > 256) {
        failures.push(`${fixture.size}:${measurement.name} exceeded the 256 MiB RSS budget.`);
      }
    }
    if (fixture.concurrent.errors > 0) failures.push(`${fixture.size}: concurrent reads failed.`);
  }
  return { ok: failures.length === 0, failures };
}

function renderMarkdown(report: {
  generatedAt: string;
  queryPlans: Record<string, QueryPlanSummary>;
  cases: Awaited<ReturnType<typeof measureFixture>>[];
  acceptance: { ok: boolean; failures: string[] };
}): string {
  const measurementRows = report.cases.flatMap((fixture) => [
    `| ${fixture.size} | baseline | ${fixture.baseline.name} | ${fixture.baseline.p50Ms} | ${fixture.baseline.p95Ms} | ${fixture.baseline.maxMs} | ${fixture.baseline.throughputPerSecond} | ${fixture.baseline.rssGrowthMb} | ${fixture.baseline.errors} |`,
    ...fixture.measurements.map((item) =>
      `| ${fixture.size} | optimized | ${item.name} | ${item.p50Ms} | ${item.p95Ms} | ${item.maxMs} | ${item.throughputPerSecond} | ${item.rssGrowthMb} | ${item.errors} |`
    ),
    ...(fixture.continuation
      ? [`| ${fixture.size} | optimized | ${fixture.continuation.name} | ${fixture.continuation.p50Ms} | ${fixture.continuation.p95Ms} | ${fixture.continuation.maxMs} | ${fixture.continuation.throughputPerSecond} | ${fixture.continuation.rssGrowthMb} | ${fixture.continuation.errors} |`]
      : [])
  ]);
  const planRows = Object.entries(report.queryPlans).map(([name, plan]) =>
    `| ${name} | ${plan.executionTimeMs ?? "n/a"} | ${plan.actualRows} | ${plan.sharedHitBlocks} | ${plan.sharedReadBlocks} | ${plan.indexNames.join(", ") || "none"} | ${plan.sequentialScanRelations.join(", ") || "none"} |`
  );
  return [
    "# Active read repair scale evidence",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "The 10,000- and 100,000-record fixtures are generated inside isolated PostgreSQL with `generate_series`; the API process reads only bounded result pages.",
    "",
    "| Records | Path | Scenario | p50 ms | p95 ms | max ms | req/s | RSS growth MiB | errors |",
    "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...measurementRows,
    "",
    "| Query plan | Execution ms | Rows | Buffer hits | Buffer reads | Indexes | Sequential scans |",
    "| --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...planRows,
    "",
    ...report.cases.map((fixture) =>
      `- ${fixture.size} records: 16-way cold concurrency completed in ${fixture.concurrent.durationMs} ms with ${fixture.concurrent.errors} errors; PostgreSQL sessions after the run: ${fixture.sessions}.`
    ),
    "- Redis page hit, miss, expiry, active-generation scope, concurrent fill, and unavailable behavior are covered by `generation-scoped-page-cache.test.ts`.",
    "",
    `Acceptance: ${report.acceptance.ok ? "PASS" : "FAIL"}`,
    ...report.acceptance.failures.map((failure) => `- ${failure}`),
    ""
  ].join("\n");
}

function knowledgeBaseIdFor(size: number): string {
  return `kb-active-read-scale-${size}`;
}

function generationIdFor(size: number): string {
  return `generation-active-read-scale-${size}`;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0);
}

function loadLocalEnvironment(): void {
  const envPath = resolve(process.cwd(), "../../.env");
  if (!existsSync(envPath)) return;
  try {
    loadEnvFile(envPath);
  } catch {
    // Explicit environment variables remain supported in CI.
  }
}

function readDatabaseUrl(): string {
  const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("PostgreSQL test configuration is incomplete");
  return databaseUrl;
}

function databaseConnectionUrl(connectionUrl: string, targetDatabaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${targetDatabaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

await main();
