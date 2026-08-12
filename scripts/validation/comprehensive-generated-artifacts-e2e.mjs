#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";

import { createLifecycleHttpClient } from "./lib/interleaved-lifecycle-api.mjs";
import {
  assertGeneratedCatalog,
  assertGeneratedContentClosure,
  assertGeneratedTreeClosure,
  assertGraphClosure,
  classifyGeneratedPath
} from "./lib/comprehensive-generated-ledger.mjs";

loadDevelopmentEnvironment();
const reportDirectory = requireReportDirectory();
const corpusReport = readJson(path.join(reportDirectory, "corpus-e2e.json"));
const databaseUrl = requireLoopbackUrl(
  "FOCOWIKI_COMPREHENSIVE_DATABASE_URL",
  ["postgres:"]
);
const adminBaseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const developerBaseUrl = `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`;
const origin = "http://127.0.0.1:43100";
const apiRequire = createRequire(path.join(process.cwd(), "apps/api/package.json"));
const postgres = apiRequire("postgres");
const { GetObjectCommand, S3Client } = apiRequire("@aws-sdk/client-s3");
const sql = postgres(databaseUrl, {
  max: 3,
  connect_timeout: 10,
  idle_timeout: 5,
  prepare: false
});
const s3 = new S3Client({
  endpoint: requireLoopbackUrl("S3_ENDPOINT", ["http:", "https:"]),
  region: requiredEnv("S3_REGION"),
  forcePathStyle: requiredBooleanEnv("S3_FORCE_PATH_STYLE"),
  credentials: {
    accessKeyId: requiredEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("S3_SECRET_ACCESS_KEY")
  }
});
const admin = createLifecycleHttpClient({ baseUrl: adminBaseUrl });
let developer = null;
let openApiKeyId = null;
const redactions = new Map();
const output = path.join(reportDirectory, "generated-artifacts-e2e.json");
let nextDeveloperRequestAt = 0;
let developerRequestGate = Promise.resolve();

try {
  const expected = buildExpectedSources(corpusReport);
  const expectedByKnowledgeBase = groupBy(expected, (row) => row.knowledgeBaseId);
  await login();
  const key = await createOpenApiKey();
  openApiKeyId = key.id;
  developer = createLifecycleHttpClient({
    baseUrl: developerBaseUrl,
    authorization: `Bearer ${key.rawKey}`
  });
  const knowledgeBases = [];
  for (const [knowledgeBaseId, expectedSources] of expectedByKnowledgeBase) {
    knowledgeBases.push(await validateKnowledgeBase({
      knowledgeBaseId,
      family: expectedSources[0].family,
      expectedSources
    }));
  }
  const report = {
    kind: "focowiki-comprehensive-generated-artifacts-e2e",
    version: 1,
    generatedAt: new Date().toISOString(),
    ok: true,
    counts: summarize(knowledgeBases),
    knowledgeBases
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, output, counts: report.counts })}\n`);
} catch (error) {
  const safeMessage = sanitizeMessage(error instanceof Error ? error.message : String(error));
  fs.writeFileSync(output, `${JSON.stringify({
    kind: "focowiki-comprehensive-generated-artifacts-e2e",
    version: 1,
    generatedAt: new Date().toISOString(),
    ok: false,
    failure: { message: safeMessage }
  }, null, 2)}\n`, { mode: 0o600 });
  throw new Error(safeMessage);
} finally {
  if (openApiKeyId) {
    await admin.json(`/admin/api/openapi-keys/${encodeURIComponent(openApiKeyId)}`, {
      method: "DELETE",
      headers: { origin }
    }).catch(() => undefined);
  }
  await admin.request("/admin/api/logout", {
    method: "POST",
    headers: { origin }
  }).catch(() => undefined);
  s3.destroy();
  await sql.end({ timeout: 5 });
}

async function validateKnowledgeBase(input) {
  remember(input.knowledgeBaseId, `${input.family}-knowledge-base`);
  const sourceAliasById = new Map(input.expectedSources.map((source) => {
    remember(source.sourceFileId, source.alias);
    return [source.sourceFileId, source.alias];
  }));
  const database = await readDatabaseEvidence(input.knowledgeBaseId);
  remember(database.activeRootId, `${input.family}-active-root`);
  remember(database.catalogGenerationId, `${input.family}-catalog-generation`);
  const sortedCatalog = sortEffectiveCatalog(database.catalog);
  const nonSourcePaths = sortedCatalog.filter((entry) => !entry.sourceFileId)
    .map((entry) => entry.logicalPath).sort(compareUtf8);
  const generatedAliasByPath = new Map(nonSourcePaths.map((logicalPath, index) => [
    logicalPath,
    `${input.family}-generated-${String(index + 1).padStart(4, "0")}`
  ]));
  const entries = sortedCatalog.map((entry) => {
    remember(entry.logicalPath, generatedAliasByPath.get(entry.logicalPath)
      ?? sourceAliasById.get(entry.sourceFileId));
    remember(entry.objectId, `${input.family}-object-${hashAlias(entry.objectId)}`);
    remember(entry.publicFileId, `${input.family}-public-file-${hashAlias(entry.publicFileId)}`);
    remember(entry.storageKey, `${input.family}-storage-${hashAlias(entry.storageKey)}`);
    return {
      alias: sourceAliasById.get(entry.sourceFileId)
        ?? generatedAliasByPath.get(entry.logicalPath),
      logicalPath: entry.logicalPath,
      kind: entry.kind,
      sourceFileId: entry.sourceFileId,
      objectId: entry.objectId,
      publicFileId: entry.publicFileId,
      storageKey: entry.storageKey,
      checksumSha256: entry.checksumSha256,
      byteCount: entry.byteCount,
      contentType: entry.contentType,
      objectState: entry.objectState,
      ownerCount: entry.ownerCount,
      ordinal: entry.ordinal
    };
  });
  const catalog = assertGeneratedCatalog(entries, {
    expectedSourceFileIds: input.expectedSources.map((source) => source.sourceFileId)
  });
  const contents = await readAllContents(input.knowledgeBaseId, entries);
  const content = assertGeneratedContentClosure(entries, contents, {
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: database.catalogGenerationId
  });
  const expectedDirectories = deriveDirectories(entries.map((entry) => entry.logicalPath));
  const [adminTree, openApiTree] = await Promise.all([
    readTree("admin", input.knowledgeBaseId),
    readTree("openapi", input.knowledgeBaseId)
  ]);
  const tree = assertGeneratedTreeClosure({
    catalogPaths: entries.map((entry) => entry.logicalPath),
    expectedDirectories,
    adminFiles: adminTree.files,
    adminDirectories: adminTree.directories,
    openApiFiles: openApiTree.files,
    openApiDirectories: openApiTree.directories
  });
  const projectionRecords = readProjectionRecords(contents);
  const graph = assertGraphClosure({
    relatedFileLimit: database.relatedFileLimit,
    sources: database.sources,
    nodes: database.nodes,
    edges: database.edges,
    evidence: database.evidence,
    projectionRecords
  });
  const related = await validateOpenApiRelationships({
    knowledgeBaseId: input.knowledgeBaseId,
    sources: database.sources,
    edges: database.edges,
    nodes: database.nodes
  });
  return {
    family: input.family,
    catalog,
    content,
    tree,
    graph,
    related,
    artifacts: entries.map((entry) => ({
      alias: entry.alias,
      pathClass: classifyGeneratedPath(entry.logicalPath, Boolean(entry.sourceFileId)),
      kind: entry.kind,
      sourceBacked: Boolean(entry.sourceFileId),
      byteCount: entry.byteCount,
      databaseVerified: true,
      s3Verified: true,
      openApiMetadataVerified: true,
      openApiContentByIdVerified: true,
      openApiContentByPathVerified: true,
      treeVerified: true
    })),
    graphItems: {
      nodes: database.nodes.map((_, index) => ({
        alias: `${input.family}-graph-node-${String(index + 1).padStart(4, "0")}`,
        currentSourceVerified: true,
        projectionVerified: true
      })),
      edges: database.edges.map((_, index) => ({
        alias: `${input.family}-graph-edge-${String(index + 1).padStart(4, "0")}`,
        endpointsVerified: true,
        evidenceVerified: true,
        forwardAndReverseVerified: true,
        projectionVerified: true
      })),
      evidence: database.evidence.map((_, index) => ({
        alias: `${input.family}-graph-evidence-${String(index + 1).padStart(4, "0")}`,
        currentRevisionVerified: true,
        checksumVerified: true,
        offsetsVerified: true
      }))
    }
  };
}

async function readDatabaseEvidence(knowledgeBaseId) {
  const [snapshot] = await sql`
    SELECT active.release_root_public_id,
           event.candidate_public_id AS catalog_generation_id,
           projection.provider_kind,
           projection.state AS projection_state,
           (
             SELECT (revision.settings_values->'sections'->'graph'->>'acceptedEdgeLimit')::integer
             FROM focowiki.runtime_setting_current current_pointer
             JOIN focowiki.runtime_setting_revisions revision
               ON revision.public_id = current_pointer.revision_public_id
             WHERE current_pointer.singleton = true
           ) AS related_file_limit
    FROM focowiki.active_snapshots active
    JOIN focowiki.search_projections projection
      ON projection.knowledge_base_id = active.knowledge_base_id
     AND projection.public_id = active.search_projection_public_id
    JOIN focowiki.release_event_summaries event
      ON event.knowledge_base_id = active.knowledge_base_id
     AND event.operation_public_id = active.activated_by_operation_public_id
     AND event.release_root_public_id = active.release_root_public_id
     AND event.outcome = 'activated'
    WHERE active.knowledge_base_id = ${knowledgeBaseId}
  `;
  if (!snapshot || snapshot.provider_kind !== "opensearch"
    || snapshot.projection_state !== "ready") {
    throw new Error("Active generated snapshot or search projection is unavailable");
  }
  const catalogRows = await sql`
    SELECT entry.logical_path,
           entry.entry_kind,
           entry.source_file_public_id,
           entry.object_id,
           coalesce(
             entry.source_file_public_id,
             focowiki.public_generated_file_id(
               ${knowledgeBaseId}, entry.logical_path
             )
           ) AS public_file_id,
           entry.checksum_sha256,
           entry.byte_count,
           entry.ordinal,
           registration.storage_key,
           registration.content_type,
           registration.state,
           count(owner.public_id) FILTER (
             WHERE owner.knowledge_base_id = ${knowledgeBaseId}
           )::integer AS owner_count
    FROM focowiki.resolve_release_catalog(${snapshot.release_root_public_id}) entry
    JOIN focowiki.object_registrations registration
      ON registration.object_id = entry.object_id
    LEFT JOIN focowiki.object_owners owner
      ON owner.object_id = entry.object_id
    GROUP BY entry.logical_path, entry.entry_kind, entry.source_file_public_id,
             entry.object_id, entry.checksum_sha256, entry.byte_count,
             entry.ordinal, registration.storage_key,
             registration.content_type, registration.state
  `;
  const sources = await sql`
    SELECT source.public_id AS source_file_id,
           current.source_revision_public_id AS revision_id,
           generated.logical_path AS page_path,
           revision.checksum_sha256 AS checksum,
           revision.byte_count
    FROM focowiki.source_files source
    JOIN focowiki.source_file_current_revisions current
      ON current.knowledge_base_id = source.knowledge_base_id
     AND current.source_file_public_id = source.public_id
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = current.knowledge_base_id
     AND revision.source_file_public_id = current.source_file_public_id
     AND revision.public_id = current.source_revision_public_id
    JOIN LATERAL focowiki.resolve_release_catalog(${snapshot.release_root_public_id}) generated
      ON generated.source_file_public_id = source.public_id
     AND generated.entry_kind = 'source'
    WHERE source.knowledge_base_id = ${knowledgeBaseId}
      AND source.deleted_at IS NULL
    ORDER BY source.public_id COLLATE "C"
  `;
  const nodes = await sql`
    SELECT node.public_id AS node_id,
           node.source_file_public_id AS source_file_id,
           node.source_revision_public_id AS revision_id,
           node.logical_path AS page_path,
           node.label AS title
    FROM focowiki.graph_nodes node
    WHERE node.knowledge_base_id = ${knowledgeBaseId}
    ORDER BY node.public_id COLLATE "C"
  `;
  const edges = await sql`
    SELECT edge.public_id AS edge_id,
           edge.from_node_public_id AS from_node_id,
           edge.to_node_public_id AS to_node_id,
           edge.relation,
           edge.weight,
           edge.reason,
           edge.edge_source
    FROM focowiki.graph_edges edge
    WHERE edge.knowledge_base_id = ${knowledgeBaseId}
    ORDER BY edge.public_id COLLATE "C"
  `;
  const evidence = await sql`
    SELECT ref.public_id AS evidence_id,
           ref.node_public_id AS node_id,
           ref.edge_public_id AS edge_id,
           ref.source_file_public_id AS source_file_id,
           ref.source_revision_public_id AS revision_id,
           ref.logical_path AS page_path,
           ref.checksum_sha256 AS checksum,
           ref.start_offset,
           ref.end_offset
    FROM focowiki.graph_evidence_refs ref
    WHERE ref.knowledge_base_id = ${knowledgeBaseId}
    ORDER BY ref.public_id COLLATE "C"
  `;
  return {
    activeRootId: snapshot.release_root_public_id,
    catalogGenerationId: snapshot.catalog_generation_id,
    relatedFileLimit: integer(snapshot.related_file_limit),
    catalog: catalogRows.map((row) => ({
      logicalPath: row.logical_path,
      kind: row.entry_kind,
      sourceFileId: row.source_file_public_id,
      objectId: row.object_id,
      publicFileId: row.public_file_id,
      checksumSha256: row.checksum_sha256,
      byteCount: integer(row.byte_count),
      ordinal: integer(row.ordinal),
      storageKey: row.storage_key,
      contentType: row.content_type,
      objectState: row.state,
      ownerCount: integer(row.owner_count)
    })),
    sources: sources.map((row) => ({
      sourceFileId: row.source_file_id,
      revisionId: row.revision_id,
      pagePath: row.page_path,
      checksum: row.checksum,
      byteCount: integer(row.byte_count)
    })),
    nodes: nodes.map((row) => ({
      nodeId: row.node_id,
      sourceFileId: row.source_file_id,
      revisionId: row.revision_id,
      pagePath: row.page_path,
      title: row.title
    })),
    edges: edges.map((row) => ({
      edgeId: row.edge_id,
      fromNodeId: row.from_node_id,
      toNodeId: row.to_node_id,
      relation: row.relation,
      weight: Number(row.weight),
      reason: row.reason,
      edgeSource: row.edge_source
    })),
    evidence: evidence.map((row) => ({
      evidenceId: row.evidence_id,
      nodeId: row.node_id,
      edgeId: row.edge_id,
      sourceFileId: row.source_file_id,
      revisionId: row.revision_id,
      pagePath: row.page_path,
      checksum: row.checksum,
      startOffset: integer(row.start_offset),
      endOffset: integer(row.end_offset)
    }))
  };
}

async function readAllContents(knowledgeBaseId, entries) {
  const output = new Map();
  await mapConcurrent(entries, 4, async (entry) => {
    const base = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`;
    const fileId = entry.publicFileId;
    const [metadata, byId, byPath, s3Object] = await Promise.all([
      readDeveloperJson(`${base}/files/${encodeURIComponent(fileId)}`),
      readDeveloperJson(`${base}/files/${encodeURIComponent(fileId)}/content`),
      readDeveloperJson(`${base}/files/content?path=${encodeURIComponent(entry.logicalPath)}`),
      readS3Object(entry.storageKey)
    ]);
    const metadataFile = metadata.file ?? metadata;
    const idContent = readContent(byId);
    const pathContent = readContent(byPath);
    const metadataMismatches = [
      metadataFile.path === entry.logicalPath ? null : "path",
      metadataFile.fileId === fileId ? null : "fileId",
      metadataFile.contentType === entry.contentType ? null : "contentType",
      Number(metadataFile.sizeBytes) === entry.byteCount ? null : "sizeBytes"
    ].filter(Boolean);
    if (metadataMismatches.length > 0) {
      throw new Error(
        `${entry.alias}: OpenAPI generated metadata diverged (${metadataMismatches.join(",")})`
      );
    }
    output.set(entry.logicalPath, {
      content: pathContent,
      apiByIdMatches: idContent === pathContent,
      s3Matches: s3Object === pathContent
    });
  });
  return output;
}

async function readS3Object(storageKey) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: requiredEnv("S3_BUCKET"),
    Key: storageKey
  }));
  if (!response.Body) throw new Error("S3 object body is missing");
  return response.Body.transformToString("utf8");
}

async function readDeveloperJson(pathname) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await paceDeveloperRequest();
    const response = await developer.request(pathname);
    const text = await response.text();
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min((retryAfter * 1_000) + 250, 60_000)
        : Math.min(250 * (2 ** attempt), 5_000);
      await sleep(delay);
      continue;
    }
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for generated OpenAPI read`);
    }
    return body;
  }
  throw new Error("Generated OpenAPI read did not recover after bounded rate-limit retries");
}

async function paceDeveloperRequest() {
  let release;
  const previous = developerRequestGate;
  developerRequestGate = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const delay = Math.max(0, nextDeveloperRequestAt - Date.now());
    if (delay > 0) await sleep(delay);
    nextDeveloperRequestAt = Date.now() + 65;
  } finally {
    release();
  }
}

async function readTree(kind, knowledgeBaseId) {
  const files = [];
  const directories = [];
  const queue = [""];
  const visited = new Set();
  while (queue.length > 0) {
    const parentPath = queue.shift();
    if (visited.has(parentPath)) throw new Error("Generated tree directory cycle detected");
    visited.add(parentPath);
    let cursor = null;
    do {
      const base = kind === "admin"
        ? `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/tree`
        : `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tree`;
      const query = new URLSearchParams({ parentPath, limit: "500" });
      if (cursor) query.set("cursor", cursor);
      const page = kind === "admin"
        ? await admin.json(`${base}?${query}`, { headers: { origin } })
        : await readDeveloperJson(`${base}?${query}`);
      for (const item of page.items ?? []) {
        const logicalPath = item.logicalPath ?? item.path;
        if (item.entryType === "directory") {
          directories.push(logicalPath);
          queue.push(logicalPath);
        } else {
          files.push(logicalPath);
        }
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
  }
  return { files, directories };
}

function readProjectionRecords(contents) {
  const catalog = JSON.parse(contents.get("_index/catalog.json").content);
  const readFamily = (name) => catalog.projections[name].shards.flatMap((shard) => {
    const body = JSON.parse(contents.get(shard.path).content);
    return body.records;
  });
  const byFile = new Map();
  for (const [logicalPath, observed] of contents) {
    if (!logicalPath.startsWith("_graph/by-file/") || !logicalPath.endsWith(".json")) continue;
    const body = JSON.parse(observed.content);
    if (!Array.isArray(body.records) || body.records.length !== 1) {
      throw new Error("By-file graph resource must contain exactly one source record");
    }
    const record = body.records[0];
    byFile.set(record.id, record.relationships ?? []);
  }
  return {
    search: readFamily("search").map((record) => record.id),
    manifest: readFamily("manifest").map((record) => record.id),
    graphNodes: readFamily("graphNodes").map((record) => record.id),
    graphEdges: readFamily("graphEdges").map((record) => record.id),
    links: readFamily("links").map((record) => record.id),
    byFile
  };
}

async function validateOpenApiRelationships(input) {
  const nodeById = new Map(input.nodes.map((node) => [node.nodeId, node]));
  const expectedBySource = new Map(input.sources.map((source) => [source.sourceFileId, []]));
  for (const edge of input.edges) {
    const from = nodeById.get(edge.fromNodeId);
    const to = nodeById.get(edge.toNodeId);
    expectedBySource.get(from.sourceFileId).push({
      edgeId: edge.edgeId,
      sourceFileId: to.sourceFileId,
      direction: "outgoing",
      relationType: edge.relation
    });
    expectedBySource.get(to.sourceFileId).push({
      edgeId: edge.edgeId,
      sourceFileId: from.sourceFileId,
      direction: "incoming",
      relationType: edge.relation
    });
  }
  let relationshipCount = 0;
  await mapConcurrent(input.sources, 8, async (source) => {
    const base = `/openapi/v2/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}`
      + `/files/${encodeURIComponent(source.sourceFileId)}/related`;
    const observed = [];
    let cursor = null;
    do {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const page = await readDeveloperJson(`${base}?${query}`);
      observed.push(...(page.items ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    const expected = expectedBySource.get(source.sourceFileId);
    const key = (item) => `${item.edgeId}\u0000${item.sourceFileId}\u0000${item.direction}\u0000${item.relationType}`;
    const observedKeys = observed.map(key);
    const expectedKeys = expected.map(key);
    if (new Set(observedKeys).size !== observedKeys.length
      || observedKeys.length !== expectedKeys.length
      || expectedKeys.some((item) => !observedKeys.includes(item))) {
      throw new Error("OpenAPI related-file response diverged from the current graph");
    }
    relationshipCount += observed.length;
  });
  return { sourceCount: input.sources.length, relationshipCount };
}

function buildExpectedSources(report) {
  if (report?.kind !== "focowiki-comprehensive-corpus-e2e" || report.ok !== true
    || report.counts?.total !== 200) {
    throw new Error("A successful 200-file corpus report is required");
  }
  return Object.entries(report.files).map(([alias, file]) => ({
    alias,
    family: file.family,
    knowledgeBaseId: report.knowledgeBases[file.family]?.id,
    sourceFileId: file.sourceFileId
  })).sort((left, right) => left.alias.localeCompare(right.alias));
}

function sortEffectiveCatalog(entries) {
  const order = new Map([
    ["index.md", 0], ["pages/index.md", 1], ["schema.md", 2], ["log.md", 3],
    ["_index/index.md", 4], ["_graph/index.md", 5], ["_index/catalog.json", 6]
  ]);
  return [...entries].sort((left, right) => {
    const leftOrder = order.get(left.logicalPath) ?? 7;
    const rightOrder = order.get(right.logicalPath) ?? 7;
    return leftOrder - rightOrder || compareUtf8(left.logicalPath, right.logicalPath);
  });
}

function deriveDirectories(paths) {
  const output = new Set();
  for (const logicalPath of paths) {
    const parts = logicalPath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      output.add(parts.slice(0, index).join("/"));
    }
  }
  return [...output].sort(compareUtf8);
}

async function login() {
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { origin },
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
}

async function createOpenApiKey() {
  const body = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin },
    json: { name: "Comprehensive generated artifact validation" },
    expectedStatus: 201
  });
  if (!body.key?.id || !body.oneTimeKey?.rawKey) {
    throw new Error("Temporary OpenAPI key response is incomplete");
  }
  return { id: body.key.id, rawKey: body.oneTimeKey.rawKey };
}

function readContent(body) {
  if (typeof body?.content !== "string") throw new Error("Generated content response is incomplete");
  return body.content;
}

async function mapConcurrent(items, concurrency, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function summarize(knowledgeBases) {
  return {
    knowledgeBases: knowledgeBases.length,
    artifacts: sum(knowledgeBases, (item) => item.catalog.entryCount),
    sourcePages: sum(knowledgeBases, (item) => item.catalog.sourceEntryCount),
    generatedSupportArtifacts: sum(knowledgeBases, (item) => item.catalog.generatedEntryCount),
    treeDirectories: sum(knowledgeBases, (item) => item.tree.directoryCount),
    graphNodes: sum(knowledgeBases, (item) => item.graph.nodeCount),
    graphEdges: sum(knowledgeBases, (item) => item.graph.edgeCount),
    graphEvidence: sum(knowledgeBases, (item) => item.graph.evidenceCount),
    byFileRelationships: sum(knowledgeBases, (item) => item.graph.byFileRelationshipCount)
  };
}

function sum(items, read) {
  return items.reduce((total, item) => total + read(item), 0);
}

function groupBy(items, read) {
  const output = new Map();
  for (const item of items) {
    const key = read(item);
    const group = output.get(key) ?? [];
    group.push(item);
    output.set(key, group);
  }
  return output;
}

function remember(value, alias) {
  if (typeof value === "string" && value && alias) redactions.set(value, alias);
}

function sanitizeMessage(message) {
  let output = String(message);
  for (const [value, alias] of [...redactions].sort((left, right) =>
    right[0].length - left[0].length)) {
    output = output.replaceAll(value, `<${alias}>`);
  }
  return output.replace(/\b(?:knowledge-base|source-file|object|release-root)-[0-9a-f-]{16,}\b/giu,
    "<redacted-identity>");
}

function hashAlias(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function integer(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Database returned an invalid nonnegative integer");
  }
  return result;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function loadDevelopmentEnvironment() {
  const file = process.env.ENV_FILE || ".env.dev.example";
  if (fs.existsSync(file)) loadEnvFile(file);
}

function requireLoopbackUrl(name, protocols) {
  const value = requiredEnv(name);
  const parsed = new URL(value);
  if (!protocols.includes(parsed.protocol)
    || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error(`${name} must target an approved loopback service`);
  }
  return value;
}

function requiredBooleanEnv(name) {
  const value = requiredEnv(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireReportDirectory() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR;
  if (!value
    || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(value)) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory");
  }
  return path.resolve(value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
