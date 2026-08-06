import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMeilisearchTransport } from
  "../../apps/api/src/infrastructure/meilisearch/meilisearch-transport.js";
import { generatedPagePath } from "../../apps/api/src/domain/source-path.js";
import { createPostgresStorageVnextCatalogRepository } from
  "../../apps/api/src/storage-vnext/catalog/postgres-repository.js";
import { createS3StorageVnextSourceBodyStore } from
  "../../apps/api/src/storage-vnext/catalog/s3-source-body-store.js";
import { createPostgresStorageVnextGraphRepository } from
  "../../apps/api/src/storage-vnext/graph/postgres-repository.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact
} from "../../apps/api/src/storage-vnext/graph/ports.js";
import { createStorageVnextMaintenanceSearchRebuild } from
  "../../apps/api/src/storage-vnext/maintenance/search-rebuild.js";
import { createStorageVnextSearchSettings } from
  "../../apps/api/src/storage-vnext/search/settings.js";

const apiRequire = createRequire(resolve(import.meta.dirname, "../../apps/api/package.json"));
const postgres = apiRequire("postgres");
const { S3Client } = apiRequire("@aws-sdk/client-s3");
const CONTENT_TYPE = "text/markdown; charset=utf-8";
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,48}$/u;

type Mode = "seed" | "verify" | "inspect";

type Arguments = {
  mode: Mode;
  runId: string;
  envFile: string;
  evidencePath: string;
  baselinePath?: string;
};

type Fixture = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
  body: string;
  metadata: Record<string, string>;
};

const fixtures: readonly Fixture[] = [
  {
    sourceFilePublicId: "source-restore-overview",
    sourceRevisionPublicId: "revision-restore-overview",
    logicalPath: "guides/overview.md",
    title: "Restore overview",
    body: [
      "# Restore overview",
      "",
      "Quasar restore anchor validates PostgreSQL and S3 authority.",
      "The overview links to the nested recovery procedure."
    ].join("\n"),
    metadata: { language: "en", fixture: "restore-rebuild" }
  },
  {
    sourceFilePublicId: "source-restore-procedure",
    sourceRevisionPublicId: "revision-restore-procedure",
    logicalPath: "guides/deep/recovery.md",
    title: "恢复校验流程",
    body: [
      "# 恢复校验流程",
      "",
      "恢复校验必须重新构建统一搜索索引，并保持路径、图谱和所有者一致。",
      "Mixed-script search marker: nebula recovery validation."
    ].join("\n"),
    metadata: { language: "zh-CN", fixture: "restore-rebuild" }
  }
];

async function main() {
  const args = parseArguments(process.argv.slice(2));
  loadEnvFile(resolve(args.envFile));
  assertLocalEndpoint(requiredEnv("S3_ENDPOINT"), "S3_ENDPOINT");
  const meiliEndpoint = normalizeMeilisearchEndpoint(requiredEnv("MEILI_HOST"));
  assertLocalEndpoint(meiliEndpoint, "MEILI_HOST");
  const databaseUrl = requiredEnv("DATABASE_URL");
  assertLocalEndpoint(databaseUrl, "DATABASE_URL");

  const sql = postgres(databaseUrl, { max: 3, idle_timeout: 5, connect_timeout: 10 });
  const s3Client = new S3Client({
    endpoint: requiredEnv("S3_ENDPOINT"),
    region: requiredEnv("S3_REGION"),
    credentials: {
      accessKeyId: requiredEnv("S3_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("S3_SECRET_ACCESS_KEY")
    },
    forcePathStyle: requiredBoolean("S3_FORCE_PATH_STYLE")
  });
  const transport = createMeilisearchTransport({
    endpoint: meiliEndpoint,
    apiKey: requiredEnv("MEILI_MASTER_KEY"),
    metricsApiKey: requiredEnv("MEILI_MASTER_KEY"),
    timeoutMs: 10_000,
    maxAttempts: 3,
    retryDelayMs: 100
  });
  const context = createContext(args.runId, sql, s3Client, transport);

  try {
    if (args.mode === "seed") {
      await assertCleanAuthority(context);
      await seedAuthority(context);
      await buildUnifiedIndex(context);
    } else if (args.mode === "verify") {
      await assertProjectionAbsent(context);
      await buildUnifiedIndex(context);
    }
    const snapshot = await captureSnapshot(context, args.mode);
    if (args.mode !== "seed") {
      if (!args.baselinePath) throw new Error("Validation baseline is required");
      const baseline = JSON.parse(await readFile(resolve(args.baselinePath), "utf8"));
      assertEquivalentSnapshot(baseline, snapshot);
    }
    await writeFile(resolve(args.evidencePath), `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600
    });
    process.stdout.write(`${JSON.stringify({
      status: "complete",
      mode: args.mode,
      evidencePath: resolve(args.evidencePath),
      checksum: checksum(snapshot.comparable)
    })}\n`);
  } finally {
    s3Client.destroy?.();
    await sql.end({ timeout: 5 });
  }
}

function createContext(runId: string, sql: any, s3Client: any, transport: any) {
  const knowledgeBaseId = `kb-restore-${runId}`;
  const indexPrefix = requiredEnv("MEILI_INDEX_PREFIX");
  const indexUid = `${indexPrefix}_restore_${checksum(runId).slice(0, 16)}`;
  return {
    runId,
    sql,
    s3Client,
    transport,
    knowledgeBaseId,
    indexUid,
    catalog: createPostgresStorageVnextCatalogRepository(sql),
    graph: createPostgresStorageVnextGraphRepository(sql),
    sourceBodies: createS3StorageVnextSourceBodyStore({
      client: s3Client,
      bucket: requiredEnv("S3_BUCKET"),
      prefix: requiredEnv("S3_PREFIX")
    })
  };
}

async function assertCleanAuthority(context: ReturnType<typeof createContext>) {
  const rows = await context.sql<Array<{ count: string }>>`
    SELECT count(*)::text AS count FROM focowiki.knowledge_bases
  `;
  if (rows[0]?.count !== "0") {
    throw new Error("Restore validation PostgreSQL authority is not clean");
  }
  await assertProjectionAbsent(context);
}

async function assertProjectionAbsent(context: ReturnType<typeof createContext>) {
  if (await context.transport.getIndex({ indexUid: context.indexUid })) {
    throw new Error("Restore validation Meilisearch projection is not clean");
  }
}

async function seedAuthority(context: ReturnType<typeof createContext>) {
  await context.catalog.createKnowledgeBase({
    publicId: context.knowledgeBaseId,
    name: `Restore validation ${context.runId}`,
    description: "Isolated backup and restore validation authority"
  });
  const guides = await context.catalog.createDirectory({
    publicId: "directory-restore-guides",
    knowledgeBaseId: context.knowledgeBaseId,
    parentPublicId: null,
    logicalPath: "guides",
    title: "Guides"
  });
  const deep = await context.catalog.createDirectory({
    publicId: "directory-restore-deep",
    knowledgeBaseId: context.knowledgeBaseId,
    parentPublicId: guides.publicId,
    logicalPath: "guides/deep",
    title: "Deep"
  });

  const current = [];
  for (const fixture of fixtures) {
    const bytes = Buffer.from(fixture.body, "utf8");
    const stored = await context.sourceBodies.putVerified({ bytes, contentType: CONTENT_TYPE });
    await context.sql`
      INSERT INTO focowiki.object_registrations
        (object_id, storage_key, checksum_sha256, byte_count, content_type,
         object_format, state, write_attempt_public_id, verified_at)
      VALUES (${stored.objectId}, ${stored.storageKey}, ${stored.checksum},
        ${stored.byteCount}, ${stored.contentType}, ${stored.objectFormat},
        'verified', ${`write-${fixture.sourceFilePublicId}`}, now())
    `;
    const source = await context.catalog.createSourceFile({
      publicId: fixture.sourceFilePublicId,
      knowledgeBaseId: context.knowledgeBaseId,
      directoryPublicId: fixture.logicalPath.includes("/deep/") ? deep.publicId : guides.publicId,
      logicalPath: fixture.logicalPath,
      title: fixture.title,
      metadata: fixture.metadata,
      status: "ready"
    });
    await context.catalog.createImmutableRevision({
      publicId: fixture.sourceRevisionPublicId,
      knowledgeBaseId: context.knowledgeBaseId,
      sourceFilePublicId: fixture.sourceFilePublicId,
      objectId: stored.objectId,
      checksum: stored.checksum,
      byteCount: stored.byteCount,
      contentType: stored.contentType,
      createdAt: "2026-08-03T00:00:00.000Z"
    });
    await context.catalog.compareAndSetCurrentRevision({
      knowledgeBaseId: context.knowledgeBaseId,
      sourceFilePublicId: fixture.sourceFilePublicId,
      revisionPublicId: fixture.sourceRevisionPublicId,
      revisionCheck: { expectedRevision: source.revision }
    });
    current.push({ fixture, stored });
  }

  const nodes = current.map(({ fixture, stored }) => graphNode(context, fixture, stored));
  await context.graph.replaceSourceFileGraph({
    knowledgeBaseId: context.knowledgeBaseId,
    sourceFilePublicId: nodes[1]!.sourceFilePublicId,
    sourceRevisionPublicId: nodes[1]!.sourceRevisionPublicId,
    node: nodes[1]!,
    edges: []
  });
  const edge = graphEdge(context, nodes[0]!, nodes[1]!);
  await context.graph.replaceSourceFileGraph({
    knowledgeBaseId: context.knowledgeBaseId,
    sourceFilePublicId: nodes[0]!.sourceFilePublicId,
    sourceRevisionPublicId: nodes[0]!.sourceRevisionPublicId,
    node: nodes[0]!,
    edges: [edge]
  });
}

function graphNode(
  context: ReturnType<typeof createContext>,
  fixture: Fixture,
  stored: { checksum: string; byteCount: number }
): StorageVnextGraphNodeFact {
  const logicalPath = generatedPagePath(fixture.logicalPath);
  return {
    publicId: `node-${fixture.sourceFilePublicId}`,
    knowledgeBaseId: context.knowledgeBaseId,
    sourceFilePublicId: fixture.sourceFilePublicId,
    sourceRevisionPublicId: fixture.sourceRevisionPublicId,
    logicalPath,
    label: fixture.title,
    kind: "page",
    metadata: {
      tags: ["restore", "rebuild"],
      contentProfile: {
        keywords: ["quasar", "恢复校验", "nebula"],
        relationshipHints: ["references"]
      }
    },
    evidence: [{
      publicId: `evidence-${fixture.sourceFilePublicId}`,
      sourceFilePublicId: fixture.sourceFilePublicId,
      sourceRevisionPublicId: fixture.sourceRevisionPublicId,
      logicalPath,
      startOffset: 0,
      endOffset: Math.min(stored.byteCount, 32),
      checksum: stored.checksum
    }],
    revision: 1
  };
}

function graphEdge(
  context: ReturnType<typeof createContext>,
  source: StorageVnextGraphNodeFact,
  target: StorageVnextGraphNodeFact
): StorageVnextGraphEdgeFact {
  return {
    publicId: "edge-restore-overview-procedure",
    knowledgeBaseId: context.knowledgeBaseId,
    fromNodePublicId: source.publicId,
    toNodePublicId: target.publicId,
    relation: "references",
    weight: 1,
    reason: "The overview references the nested recovery procedure.",
    source: "validation-fixture",
    metadata: {},
    evidence: [{
      ...source.evidence[0]!,
      publicId: "evidence-edge-restore-overview-procedure"
    }],
    revision: 1
  };
}

async function buildUnifiedIndex(context: ReturnType<typeof createContext>) {
  await waitForTask(context.transport, (await context.transport.createIndex({
    indexUid: context.indexUid,
    primaryKey: "id"
  })).taskUid);
  await waitForTask(context.transport, (await context.transport.updateSettings({
    indexUid: context.indexUid,
    settings: createStorageVnextSearchSettings({ searchCutoffMs: 500 })
  })).taskUid);

  const rebuild = createStorageVnextMaintenanceSearchRebuild({
    catalog: context.catalog,
    sourceBodies: context.sourceBodies,
    graph: context.graph,
    projection: {
      async writeDocumentBatch(input) {
        await waitForTask(context.transport, (await context.transport.addDocuments({
          indexUid: context.indexUid,
          primaryKey: "id",
          documents: [...input.documents],
          correlation: `${input.operationPublicId}-${input.batchOrdinal}`
        })).taskUid);
      }
    },
    limits: {
      sourcePageSize: 1,
      graphPageSize: 1,
      maxSourceBytes: 1_048_576,
      maxSegmentBytes: 16_384,
      maxBatchDocuments: 20,
      maxBatchCompressedBytes: 1_048_576
    }
  });
  let cursor: string | null = null;
  let batchOrdinal = 0;
  for (let page = 0; page < 20; page += 1) {
    const result = await rebuild.runPage({
      knowledgeBaseId: context.knowledgeBaseId,
      candidatePublicId: context.indexUid,
      operationPublicId: `operation-restore-${context.runId}`,
      cursor,
      batchOrdinal
    });
    batchOrdinal += result.batchOrdinalDelta;
    if (result.outcome === "phase_completed") return;
    cursor = result.cursor;
  }
  throw new Error("Restore validation search rebuild did not converge");
}

async function waitForTask(transport: any, taskUid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await transport.getTask(taskUid);
    if (task.status === "succeeded") return;
    if (task.status === "failed" || task.status === "canceled") {
      throw new Error(`Meilisearch task ${taskUid} failed`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Meilisearch task ${taskUid} timed out`);
}

async function captureSnapshot(context: ReturnType<typeof createContext>, mode: Mode) {
  const indexes = await context.transport.listIndexes({ offset: 0, limit: 100 });
  const ownedIndexes = indexes.indexes.filter((item: { uid: string }) =>
    item.uid === context.indexUid);
  if (ownedIndexes.length !== 1) throw new Error("Expected one unified index per knowledge base");

  const catalog = await readAllCurrentSources(context);
  const nodes = await readAllGraphNodes(context);
  const edges = await readAllGraphEdges(context);
  const owners = await context.sql`
    SELECT owner.object_id, owner.owner_kind, owner.source_revision_public_id
    FROM focowiki.object_owners AS owner
    WHERE owner.knowledge_base_id = ${context.knowledgeBaseId}
    ORDER BY owner.object_id, owner.owner_kind, owner.public_id
  `;
  const directories = await context.sql`
    SELECT public_id, parent_public_id, logical_path, normalized_path, title, revision
    FROM focowiki.source_directories
    WHERE knowledge_base_id = ${context.knowledgeBaseId}
    ORDER BY logical_path COLLATE "C"
  `;
  const bodies = [];
  for (const item of catalog) {
    const bytes = await context.sourceBodies.readVerified({
      objectId: item.sourceRevision.objectId,
      checksum: item.sourceRevision.checksum,
      byteCount: item.sourceRevision.byteCount,
      contentType: item.sourceRevision.contentType,
      maxBytes: 1_048_576
    });
    bodies.push({
      objectId: item.sourceRevision.objectId,
      checksum: checksum(Buffer.from(bytes)),
      byteCount: bytes.byteLength
    });
  }
  const documents = await context.transport.listDocuments({
    indexUid: context.indexUid,
    offset: 0,
    limit: 1_000,
    fields: ["*"]
  });
  const sortedDocuments = [...documents.documents].sort((left, right) =>
    String(left.id).localeCompare(String(right.id)));
  const englishSearch = await search(context, "quasar restore anchor");
  const chineseSearch = await search(context, "恢复校验");
  const comparable = canonical({
    runId: context.runId,
    knowledgeBaseId: context.knowledgeBaseId,
    indexUid: context.indexUid,
    directories,
    catalog,
    bodies,
    nodes,
    edges,
    owners,
    documents: sortedDocuments,
    search: {
      english: englishSearch.hits.map((hit: Record<string, unknown>) => ({
        id: hit.id,
        sourceFilePublicId: hit.sourceFilePublicId,
        logicalPath: hit.logicalPath,
        documentKind: hit.documentKind
      })),
      chinese: chineseSearch.hits.map((hit: Record<string, unknown>) => ({
        id: hit.id,
        sourceFilePublicId: hit.sourceFilePublicId,
        logicalPath: hit.logicalPath,
        documentKind: hit.documentKind
      }))
    },
    counts: {
      directories: directories.length,
      sources: catalog.length,
      bodies: bodies.length,
      graphNodes: nodes.length,
      graphEdges: edges.length,
      owners: owners.length,
      searchDocuments: documents.total,
      unifiedIndexes: ownedIndexes.length
    }
  });
  return {
    format: "focowiki-storage-vnext-restore-rebuild-evidence-v1",
    mode,
    capturedAt: new Date().toISOString(),
    comparable,
    checksums: {
      catalog: checksum(comparable.catalog),
      bodies: checksum(comparable.bodies),
      graph: checksum({ nodes: comparable.nodes, edges: comparable.edges }),
      owners: checksum(comparable.owners),
      search: checksum({ documents: comparable.documents, search: comparable.search }),
      complete: checksum(comparable)
    }
  };
}

async function readAllCurrentSources(context: ReturnType<typeof createContext>) {
  const items = [];
  let cursor: string | null = null;
  do {
    const page = await context.catalog.listCurrentSources({
      knowledgeBaseId: context.knowledgeBaseId,
      limit: 100,
      cursor
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items.sort((left, right) =>
    left.sourceFile.logicalPath.localeCompare(right.sourceFile.logicalPath));
}

async function readAllGraphNodes(context: ReturnType<typeof createContext>) {
  const items = [];
  let cursor: string | null = null;
  do {
    const page = await context.graph.listNodes({
      knowledgeBaseId: context.knowledgeBaseId,
      limit: 100,
      cursor
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items.sort((left, right) => left.publicId.localeCompare(right.publicId));
}

async function readAllGraphEdges(context: ReturnType<typeof createContext>) {
  const items = [];
  let cursor: string | null = null;
  do {
    const page = await context.graph.listEdges({
      knowledgeBaseId: context.knowledgeBaseId,
      limit: 100,
      cursor
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items.sort((left, right) => left.publicId.localeCompare(right.publicId));
}

async function search(context: ReturnType<typeof createContext>, query: string) {
  return context.transport.search({
    indexUid: context.indexUid,
    query,
    filter: `knowledgeBaseId = "${context.knowledgeBaseId}"`,
    limit: 20,
    attributesToRetrieve: [
      "id",
      "sourceFilePublicId",
      "logicalPath",
      "documentKind"
    ],
    attributesToCrop: [],
    cropLength: 20,
    matchingStrategy: "last"
  });
}

function assertEquivalentSnapshot(baseline: any, actual: any) {
  if (
    baseline?.format !== "focowiki-storage-vnext-restore-rebuild-evidence-v1"
    || checksum(baseline.comparable) !== checksum(actual.comparable)
  ) {
    throw new Error("Restored authority or rebuilt projection differs from the baseline");
  }
}

function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T;
  if (value instanceof Date) return value.toISOString() as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)])) as T;
  }
  return value;
}

function checksum(value: unknown): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(canonical(value)));
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv: string[]): Arguments {
  if (!argv[0] || !["seed", "verify", "inspect"].includes(argv[0])) {
    throw new Error("Restore rebuild mode must be seed, verify, or inspect");
  }
  const options: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Restore rebuild option requires a value: ${key ?? "<missing>"}`);
    }
    options[key] = value;
  }
  const runId = options["--run-id"];
  const envFile = options["--env-file"];
  const evidencePath = options["--evidence"];
  if (!runId || !RUN_ID_PATTERN.test(runId)) throw new Error("Restore rebuild run ID is invalid");
  if (!envFile || !evidencePath) throw new Error("Restore rebuild paths are required");
  return {
    mode: argv[0] as Mode,
    runId,
    envFile,
    evidencePath,
    ...(options["--baseline"] ? { baselinePath: options["--baseline"] } : {})
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for restore rebuild validation`);
  return value;
}

function requiredBoolean(name: string): boolean {
  const value = requiredEnv(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function normalizeMeilisearchEndpoint(value: string): string {
  const url = new URL(value);
  if (url.hostname === "meilisearch") url.hostname = "127.0.0.1";
  if (url.port === "7700") url.port = process.env.MEILI_PORT ?? "57700";
  return url.toString().replace(/\/$/u, "");
}

function assertLocalEndpoint(value: string, name: string) {
  const hostname = new URL(value).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
    throw new Error(`${name} must use an isolated loopback endpoint`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Restore rebuild failed"}\n`);
    process.exitCode = 1;
  });
}
