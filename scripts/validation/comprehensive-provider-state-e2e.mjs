#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import {
  classifyComprehensiveCleanupIndexes,
  classifyComprehensiveQuarantinedIndexes,
  classifyComprehensiveRetainedLexicalIndexes,
  classifyComprehensiveRetainedSemanticIndexes,
  extractComprehensiveMeilisearchVectorDimension,
  reconcileComprehensiveProviderCluster,
  reconcileComprehensiveProviderState
} from "./lib/comprehensive-provider-state.mjs";

const envPath = path.resolve(process.env.ENV_FILE || ".env");
if (fs.existsSync(envPath)) loadEnvFile(envPath);

const provider = requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_PROVIDER");
const providerBaseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_PROVIDER_BASE_URL");
const providerAuthorization = provider === "meilisearch"
  ? `Bearer ${process.env.FOCOWIKI_COMPREHENSIVE_PROVIDER_API_KEY?.trim()
      || requiredEnv("MEILI_MASTER_KEY")}`
  : null;
const databaseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_DATABASE_URL");
const reportDirectory = path.resolve(requiredEnv("FOCOWIKI_COMPREHENSIVE_REPORT_DIR"));
const indexPrefix = process.env.FOCOWIKI_COMPREHENSIVE_SEARCH_INDEX_PREFIX?.trim()
  || "focowiki_dev";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_PROVIDER_STATE_REPORT?.trim()
    || path.join(reportDirectory, `search-provider-${provider}-state.json`)
);
const apiRequire = createRequire(path.join(process.cwd(), "apps/api/package.json"));
const postgres = apiRequire("postgres");
const sql = postgres(databaseUrl, {
  max: 2,
  connect_timeout: 10,
  idle_timeout: 5,
  prepare: false
});

if (!new Set(["opensearch", "meilisearch"]).has(provider)) {
  throw new Error("Comprehensive provider state has an unsupported provider");
}

try {
  const database = await readDatabaseState();
  const providerKnowledgeBases = [];
  for (const knowledgeBase of database.knowledgeBases) {
    const lexical = await readProviderIndex(knowledgeBase.lexicalIndexUid, false);
    const vector = await readProviderIndex(knowledgeBase.vectorIndexUid, true);
    providerKnowledgeBases.push({
      knowledgeBaseId: knowledgeBase.knowledgeBaseId,
      sourceFileIds: knowledgeBase.sourceFileIds,
      lexical: {
        indexUid: knowledgeBase.lexicalIndexUid,
        expectedDocumentCount: knowledgeBase.lexicalDocumentCount,
        documents: lexical.documents.map((document) => ({
          id: document.id,
          knowledgeBaseId: document.knowledgeBaseId,
          sourceFileId: document.sourceFileId,
          visible: document.visible
        }))
      },
      vector: {
        indexUid: knowledgeBase.vectorIndexUid,
        expectedDocuments: knowledgeBase.vectorDocuments,
        documents: vector.documents.map((document) => ({
          id: document.id,
          knowledgeBaseId: document.knowledgeBaseId,
          sourceFileId: document.sourceFileId,
          family: document.family
        })),
        mappingDimension: vector.vectorDimension
      },
      providerEvidence: {
        lexical: lexical.evidence,
        vector: vector.evidence
      }
    });
  }
  const reconciliation = reconcileComprehensiveProviderState({
    knowledgeBases: providerKnowledgeBases
  });
  const [cluster, activeWriteTaskCount] = provider === "opensearch"
    ? await Promise.all([
        readOpenSearchClusterResources(),
        readOpenSearchActiveWriteTaskCount()
      ])
    : await Promise.all([
        readMeilisearchResources(),
        readMeilisearchActiveWriteTaskCount()
      ]);
  const declaredIndexUids = [
    ...providerKnowledgeBases.flatMap((knowledgeBase) => [
      knowledgeBase.lexical.indexUid,
      knowledgeBase.vector.indexUid
    ]),
    ...database.retainedIndexes.map((index) => index.indexUid)
  ];
  const quarantinedIndexes = classifyComprehensiveQuarantinedIndexes({
    provider,
    now: database.observedAt,
    stagingRetentionHours: database.stagingRetentionHours,
    declaredIndexUids,
    rows: providerClusterIndexRows(cluster, provider)
  });
  const clusterReconciliation = reconcileComprehensiveProviderCluster({
    provider,
    expectedIndexes: providerKnowledgeBases.flatMap((knowledgeBase) => [{
      indexUid: knowledgeBase.lexical.indexUid,
      documentCount: knowledgeBase.lexical.expectedDocumentCount
    }, {
      indexUid: knowledgeBase.vector.indexUid,
      documentCount: knowledgeBase.vector.expectedDocuments.length
    }]),
    retainedIndexes: database.retainedIndexes,
    quarantinedIndexes,
    expectedAliases: [],
    cluster
  });
  const report = {
    format: "focowiki-comprehensive-provider-state-v2",
    provider,
    generatedAt: new Date().toISOString(),
    ok: reconciliation.ok && clusterReconciliation.ok,
    database: {
      knowledgeBases: database.knowledgeBases.map((knowledgeBase) => ({
        knowledgeBaseId: knowledgeBase.knowledgeBaseId,
        sourceFileCount: knowledgeBase.sourceFileIds.length,
        lexicalIndexUid: knowledgeBase.lexicalIndexUid,
        lexicalProjectionPublicId: knowledgeBase.lexicalProjectionPublicId,
        lexicalDocumentCount: knowledgeBase.lexicalDocumentCount,
        lexicalProviderOperationRef: knowledgeBase.lexicalProviderOperationRef,
        lexicalChecksums: knowledgeBase.lexicalChecksums,
        semanticGenerationPublicId: knowledgeBase.semanticGenerationPublicId,
        vectorIndexUid: knowledgeBase.vectorIndexUid,
        vectorDocumentCount: knowledgeBase.vectorDocuments.length,
        vectorMappingFingerprintSha256: knowledgeBase.vectorMappingFingerprintSha256,
        vectorDimension: knowledgeBase.vectorDimension
      })),
      retainedIndexes: database.retainedIndexes,
      quarantinedIndexes,
      stagingRetentionHours: database.stagingRetentionHours
    },
    reconciliation,
    knowledgeBases: providerKnowledgeBases.map((knowledgeBase) => ({
      knowledgeBaseId: knowledgeBase.knowledgeBaseId,
      sourceFileIds: knowledgeBase.sourceFileIds,
      lexical: knowledgeBase.lexical,
      vector: knowledgeBase.vector,
      providerEvidence: knowledgeBase.providerEvidence
    })),
    tasks: {
      activeWriteTaskCount
    },
    clusterReconciliation,
    cluster
  };
  writePrivateReport(reportPath, report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    provider,
    reportPath,
    activeWriteTaskCount: report.tasks.activeWriteTaskCount,
    knowledgeBases: reconciliation.knowledgeBases
  })}\n`);
} finally {
  await sql.end({ timeout: 5 });
}

async function readDatabaseState() {
  const [runtime] = await sql`
    SELECT current_timestamp AS observed_at,
           (settings.settings_values #>>
             '{sections,search,stagingRetentionHours}')::integer
             AS staging_retention_hours
    FROM focowiki.runtime_setting_current current_settings
    JOIN focowiki.runtime_setting_revisions settings
      ON settings.public_id = current_settings.revision_public_id
  `;
  if (!runtime || !Number.isSafeInteger(runtime.staging_retention_hours)) {
    throw new Error("Comprehensive provider staging retention is unavailable");
  }
  const projectionRows = await sql`
    SELECT snapshot.knowledge_base_id,
           projection.public_id AS lexical_projection_public_id,
           projection.provider_kind,
           projection.provider_index_uid AS lexical_index_uid,
           projection.document_count AS lexical_document_count,
           projection.provider_operation_ref AS lexical_provider_operation_ref,
           projection.schema_checksum_sha256,
           projection.settings_checksum_sha256,
           projection.document_checksum_sha256,
           generation.public_id AS semantic_generation_public_id,
           contract.mapping_fingerprint_sha256,
           contract.resolved_dimension
    FROM focowiki.active_snapshots snapshot
    JOIN focowiki.search_projections projection
      ON projection.knowledge_base_id = snapshot.knowledge_base_id
     AND projection.public_id = snapshot.search_projection_public_id
     AND projection.projection_role = 'active'
     AND projection.state = 'ready'
    JOIN focowiki.semantic_generations generation
      ON generation.knowledge_base_id = snapshot.knowledge_base_id
     AND generation.generation_role = 'active'
     AND generation.state = 'active'
     AND generation.deleted_at IS NULL
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = generation.knowledge_base_id
     AND contract.semantic_generation_public_id = generation.public_id
    ORDER BY snapshot.knowledge_base_id COLLATE "C"
  `;
  if (projectionRows.length !== 2) {
    throw new Error("Comprehensive provider state requires exactly two active knowledge bases");
  }
  const knowledgeBases = [];
  for (const row of projectionRows) {
    if (row.provider_kind !== provider) {
      throw new Error("Comprehensive provider state does not match the selected provider");
    }
    const [sources, vectors] = await Promise.all([
      sql`
        SELECT source.public_id
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = ${row.knowledge_base_id}
          AND source.status = 'ready'
          AND source.deleted_at IS NULL
        ORDER BY source.public_id COLLATE "C"
      `,
      sql`
        SELECT vector.provider_document_id AS id,
               vector.source_file_public_id AS source_file_id,
               vector.vector_family AS family,
               vector.dimension
        FROM focowiki.semantic_vector_documents vector
        WHERE vector.knowledge_base_id = ${row.knowledge_base_id}
          AND vector.semantic_generation_public_id
            = ${row.semantic_generation_public_id}
          AND vector.state = 'active'
          AND vector.deleted_at IS NULL
        ORDER BY vector.provider_document_id COLLATE "C"
      `
    ]);
    const vectorIndexUid = semanticVectorIndexUid({
      indexPrefix,
      knowledgeBaseId: row.knowledge_base_id,
      semanticGenerationPublicId: row.semantic_generation_public_id,
      mappingFingerprintSha256: row.mapping_fingerprint_sha256
    });
    knowledgeBases.push({
      knowledgeBaseId: row.knowledge_base_id,
      sourceFileIds: sources.map((source) => source.public_id),
      lexicalProjectionPublicId: row.lexical_projection_public_id,
      lexicalIndexUid: row.lexical_index_uid,
      lexicalDocumentCount: Number(row.lexical_document_count),
      lexicalProviderOperationRef: row.lexical_provider_operation_ref,
      lexicalChecksums: {
        schemaSha256: row.schema_checksum_sha256,
        settingsSha256: row.settings_checksum_sha256,
        documentsSha256: row.document_checksum_sha256
      },
      semanticGenerationPublicId: row.semantic_generation_public_id,
      vectorIndexUid,
      vectorMappingFingerprintSha256: row.mapping_fingerprint_sha256,
      vectorDimension: row.resolved_dimension,
      vectorDocuments: vectors.map((vector) => ({
        id: vector.id,
        sourceFileId: vector.source_file_id,
        family: vector.family,
        dimension: vector.dimension
      }))
    });
  }
  const retainedRows = await sql`
    SELECT generation.knowledge_base_id,
           generation.public_id AS semantic_generation_public_id,
           contract.mapping_fingerprint_sha256,
           count(vector.*) FILTER (
             WHERE vector.deleted_at IS NULL
           ) AS vector_document_count
    FROM focowiki.semantic_generations generation
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = generation.knowledge_base_id
     AND contract.semantic_generation_public_id = generation.public_id
     AND contract.search_provider_kind = ${provider}
    LEFT JOIN focowiki.semantic_vector_documents vector
      ON vector.knowledge_base_id = generation.knowledge_base_id
     AND vector.semantic_generation_public_id = generation.public_id
    WHERE generation.knowledge_base_id IN ${sql(
      knowledgeBases.map((knowledgeBase) => knowledgeBase.knowledgeBaseId)
    )}
      AND generation.generation_role = 'historical'
      AND generation.state = 'superseded'
      AND generation.deleted_at IS NULL
    GROUP BY generation.knowledge_base_id, generation.public_id,
             contract.mapping_fingerprint_sha256
    ORDER BY generation.knowledge_base_id COLLATE "C",
             generation.public_id COLLATE "C"
  `;
  const retainedIndexes = classifyComprehensiveRetainedSemanticIndexes({
    rows: retainedRows.map((row) => ({
      indexUid: semanticVectorIndexUid({
        indexPrefix,
        knowledgeBaseId: row.knowledge_base_id,
        semanticGenerationPublicId: row.semantic_generation_public_id,
        mappingFingerprintSha256: row.mapping_fingerprint_sha256
      }),
      liveDocumentCount: Number(row.vector_document_count)
    }))
  });
  const retainedLexicalRows = await sql`
    SELECT projection.provider_index_uid,
           projection.document_count,
           projection.projection_role,
           projection.state,
           projection.updated_at,
           current_timestamp AS database_now,
           (settings.settings_values #>>
             '{sections,maintenance,quarantineGracePeriodSeconds}')::integer
             AS quarantine_grace_period_seconds
    FROM focowiki.search_projections projection
    CROSS JOIN focowiki.runtime_setting_current current_settings
    JOIN focowiki.runtime_setting_revisions settings
      ON settings.public_id = current_settings.revision_public_id
    WHERE projection.knowledge_base_id IN ${sql(
      knowledgeBases.map((knowledgeBase) => knowledgeBase.knowledgeBaseId)
    )}
      AND projection.provider_kind = ${provider}
      AND projection.projection_role = 'candidate'
      AND projection.state = 'failed'
    ORDER BY projection.provider_index_uid COLLATE "C"
  `;
  const retainedLexicalIndexes = retainedLexicalRows.length === 0
    ? []
    : classifyComprehensiveRetainedLexicalIndexes({
        now: isoTimestamp(retainedLexicalRows[0].database_now),
        quarantineGracePeriodSeconds: Number(
          retainedLexicalRows[0].quarantine_grace_period_seconds
        ),
        rows: retainedLexicalRows.map((row) => ({
          indexUid: row.provider_index_uid,
          documentCount: Number(row.document_count),
          projectionRole: row.projection_role,
          state: row.state,
          updatedAt: isoTimestamp(row.updated_at)
        }))
      });
  const cleanupRows = await sql`
    SELECT action.action_kind, action.cleanup_plane,
           action.search_provider_kind, action.resource_kind,
           action.resource_public_id, action.state, action.checkpoint
    FROM focowiki.cleanup_actions action
    WHERE action.knowledge_base_id IN ${sql(
      knowledgeBases.map((knowledgeBase) => knowledgeBase.knowledgeBaseId)
    )}
      AND action.action_kind = 'provider_adoption'
      AND action.cleanup_plane = 'search'
      AND action.search_provider_kind = ${provider}
      AND action.resource_kind = 'search_index'
      AND action.state IN ('queued', 'running', 'retry')
      AND action.checkpoint ? 'providerIndexUid'
      AND action.checkpoint ? 'documentCount'
    ORDER BY action.resource_public_id COLLATE "C"
  `;
  const cleanupIndexes = classifyComprehensiveCleanupIndexes({
    provider,
    rows: cleanupRows.map((row) => ({
      actionKind: row.action_kind,
      cleanupPlane: row.cleanup_plane,
      searchProviderKind: row.search_provider_kind,
      resourceKind: row.resource_kind,
      resourcePublicId: row.resource_public_id,
      state: row.state,
      checkpoint: row.checkpoint
    }))
  });
  return {
    knowledgeBases,
    observedAt: isoTimestamp(runtime.observed_at),
    stagingRetentionHours: runtime.staging_retention_hours,
    retainedIndexes: mergeRetainedIndexes([
      ...retainedIndexes,
      ...retainedLexicalIndexes,
      ...cleanupIndexes
    ])
  };
}

async function readOpenSearchIndex(indexUid, vector) {
  const [mapping, settings, count, enumeration] = await Promise.all([
    requestJson(`/${encodeURIComponent(indexUid)}/_mapping`),
    requestJson(`/${encodeURIComponent(indexUid)}/_settings`),
    requestJson(`/${encodeURIComponent(indexUid)}/_count`),
    readAllOpenSearchDocuments(indexUid, vector)
  ]);
  if (enumeration.documents.length !== count.count) {
    throw new Error(`Comprehensive provider index enumeration is incomplete: ${indexUid}`);
  }
  const properties = mapping[indexUid]?.mappings?.properties ?? {};
  return {
    documents: enumeration.documents,
    vectorDimension: vector ? Number(properties.vector?.dimension) : null,
    evidence: {
      count: Number(count.count),
      mappingFields: Object.keys(properties).sort(),
      mappingSha256: sha256(stableJson(mapping[indexUid]?.mappings ?? {})),
      settingsSha256: sha256(stableJson(settings[indexUid]?.settings?.index ?? {})),
      enumerationPageCount: enumeration.pageCount,
      enumerationTookMs: enumeration.tookMs,
      timedOut: false
    }
  };
}

async function readProviderIndex(indexUid, vector) {
  return provider === "opensearch"
    ? readOpenSearchIndex(indexUid, vector)
    : readMeilisearchIndex(indexUid, vector);
}

async function readMeilisearchIndex(indexUid, vector) {
  const [settings, stats, enumeration] = await Promise.all([
    requestJson(`/indexes/${encodeURIComponent(indexUid)}/settings`),
    requestJson(`/indexes/${encodeURIComponent(indexUid)}/stats`),
    readAllMeilisearchDocuments(indexUid, vector)
  ]);
  if (enumeration.documents.length !== Number(stats.numberOfDocuments)) {
    throw new Error(`Comprehensive provider index enumeration is incomplete: ${indexUid}`);
  }
  const fields = [...new Set([
    ...(settings.displayedAttributes ?? []),
    ...(settings.searchableAttributes ?? []),
    ...(settings.filterableAttributes ?? []).flatMap((item) =>
      typeof item === "string" ? [item] : item?.attributePatterns ?? []
    ),
    ...(settings.sortableAttributes ?? [])
  ])].sort();
  return {
    documents: enumeration.documents,
    vectorDimension: vector
      ? extractComprehensiveMeilisearchVectorDimension(settings)
      : null,
    evidence: {
      count: Number(stats.numberOfDocuments),
      mappingFields: fields,
      settingsSha256: sha256(stableJson(settings)),
      databaseSizeBytes: Number(stats.databaseSize ?? 0),
      usedDatabaseSizeBytes: Number(stats.usedDatabaseSize ?? 0),
      enumerationPageCount: enumeration.pageCount,
      timedOut: false
    }
  };
}

async function readAllOpenSearchDocuments(indexUid, vector) {
  const documents = [];
  let searchAfter;
  let pageCount = 0;
  let tookMs = 0;
  while (true) {
    const search = await requestJson(`/${encodeURIComponent(indexUid)}/_search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        size: 500,
        sort: [{ id: "asc" }],
        ...(searchAfter ? { search_after: searchAfter } : {}),
        _source: vector
          ? ["knowledgeBaseId", "sourceFilePublicId", "family"]
          : ["knowledgeBaseId", "sourceFilePublicId", "visible"]
      })
    });
    if (search.timed_out === true) {
      throw new Error(`Comprehensive provider index enumeration timed out: ${indexUid}`);
    }
    const hits = search.hits?.hits ?? [];
    pageCount += 1;
    tookMs += Number(search.took ?? 0);
    for (const hit of hits) {
      documents.push({
        id: hit._id,
        knowledgeBaseId: hit._source?.knowledgeBaseId,
        sourceFileId: hit._source?.sourceFilePublicId,
        ...(vector
          ? { family: hit._source?.family }
          : { visible: hit._source?.visible })
      });
    }
    if (hits.length < 500) break;
    const continuation = hits.at(-1)?.sort;
    if (!Array.isArray(continuation) || continuation.length === 0) {
      throw new Error(`Comprehensive provider index continuation is missing: ${indexUid}`);
    }
    searchAfter = continuation;
  }
  return { documents, pageCount, tookMs };
}

async function readAllMeilisearchDocuments(indexUid, vector) {
  const documents = [];
  let offset = 0;
  let pageCount = 0;
  while (true) {
    const fields = vector
      ? "id,knowledgeBaseId,sourceFilePublicId,family"
      : "id,knowledgeBaseId,sourceFilePublicId,visible";
    const page = await requestJson(
      `/indexes/${encodeURIComponent(indexUid)}/documents?limit=500&offset=${offset}&fields=${encodeURIComponent(fields)}`
    );
    const results = page.results ?? [];
    pageCount += 1;
    for (const document of results) {
      documents.push({
        id: document.id,
        knowledgeBaseId: document.knowledgeBaseId,
        sourceFileId: document.sourceFilePublicId,
        ...(vector
          ? { family: document.family }
          : { visible: document.visible })
      });
    }
    if (results.length < 500) break;
    offset += results.length;
  }
  return { documents, pageCount };
}

async function readOpenSearchActiveWriteTaskCount() {
  const tasks = await requestJson(
    "/_tasks?detailed=false&actions=indices:data/write/*"
  );
  return Object.values(tasks.nodes ?? {}).reduce(
    (total, node) => total + Object.keys(node.tasks ?? {}).length,
    0
  );
}

async function readMeilisearchActiveWriteTaskCount() {
  const tasks = await requestJson("/tasks?statuses=enqueued,processing&limit=100");
  return Number(tasks.total ?? tasks.results?.length ?? 0);
}

async function readOpenSearchClusterResources() {
  const [health, nodes, indexRows, aliasRows, indexSettings] = await Promise.all([
    requestJson("/_cluster/health"),
    requestJson("/_nodes/stats/process,jvm,os,fs,indices"),
    requestJson("/_cat/indices?format=json&h=index,docs.count,store.size,status,health"),
    requestJson("/_cat/aliases?format=json&h=alias,index"),
    requestJson(`/${encodeURIComponent(indexPrefix)}*/_settings?filter_path=*.settings.index.creation_date`)
  ]);
  const summaries = Object.entries(nodes.nodes ?? {}).map(([nodeId, node]) => ({
    nodeIdSha256: sha256(nodeId),
    processCpuPercent: node.process?.cpu?.percent ?? null,
    processVirtualBytes: node.process?.mem?.total_virtual_in_bytes ?? null,
    jvmHeapUsedBytes: node.jvm?.mem?.heap_used_in_bytes ?? null,
    jvmHeapCommittedBytes: node.jvm?.mem?.heap_committed_in_bytes ?? null,
    filesystemAvailableBytes: node.fs?.total?.available_in_bytes ?? null,
    documentCount: node.indices?.docs?.count ?? null,
    storeBytes: node.indices?.store?.size_in_bytes ?? null,
    queryCount: node.indices?.search?.query_total ?? null,
    queryTimeMs: node.indices?.search?.query_time_in_millis ?? null
  }));
  return {
    status: health.status,
    timedOut: health.timed_out === true,
    nodeCount: health.number_of_nodes,
    dataNodeCount: health.number_of_data_nodes,
    activePrimaryShards: health.active_primary_shards,
    activeShards: health.active_shards,
    unassignedShards: health.unassigned_shards,
    indices: indexRows
      .filter((item) => String(item.index ?? "").startsWith(indexPrefix))
      .map((item) => ({
        indexUid: item.index,
        documentCount: Number(item["docs.count"] ?? 0),
        storeSize: item["store.size"] ?? null,
        status: item.status,
        health: item.health,
        updatedAt: readIndexCreationTimestamp(indexSettings[item.index])
      }))
      .sort((left, right) => left.indexUid.localeCompare(right.indexUid, "en")),
    aliases: aliasRows
      .filter((item) => String(item.alias ?? "").startsWith(indexPrefix)
        || String(item.index ?? "").startsWith(indexPrefix))
      .map((item) => ({ alias: item.alias, indexUid: item.index }))
      .sort((left, right) => left.alias.localeCompare(right.alias, "en")
        || left.indexUid.localeCompare(right.indexUid, "en")),
    nodes: summaries
  };
}

async function readMeilisearchResources() {
  const [health, stats, indexPage] = await Promise.all([
    requestJson("/health"),
    requestJson("/stats"),
    requestJson("/indexes?limit=1000")
  ]);
  const updatedAtByIndex = new Map((indexPage.results ?? []).map((item) => [
    item.uid,
    isoTimestamp(item.updatedAt)
  ]));
  return {
    status: health.status,
    databaseSizeBytes: Number(stats.databaseSize ?? 0),
    usedDatabaseSizeBytes: Number(stats.usedDatabaseSize ?? 0),
    lastUpdate: stats.lastUpdate ?? null,
    indexCount: Object.keys(stats.indexes ?? {}).length,
    indexes: Object.fromEntries(Object.entries(stats.indexes ?? {})
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([indexUid, value]) => [indexUid, {
        numberOfDocuments: Number(value.numberOfDocuments ?? 0),
        isIndexing: value.isIndexing === true,
        updatedAt: updatedAtByIndex.get(indexUid) ?? null
      }]))
  };
}

function providerClusterIndexRows(cluster, providerKind) {
  if (providerKind === "opensearch") {
    return cluster.indices.map((index) => ({
      indexUid: index.indexUid,
      documentCount: index.documentCount,
      updatedAt: index.updatedAt
    }));
  }
  return Object.entries(cluster.indexes).map(([indexUid, index]) => ({
    indexUid,
    documentCount: index.numberOfDocuments,
    updatedAt: index.updatedAt
  }));
}

function readIndexCreationTimestamp(value) {
  const creationDate = value?.settings?.index?.creation_date;
  if (typeof creationDate !== "string" || !/^\d+$/u.test(creationDate)) {
    throw new Error("Comprehensive provider index creation time is invalid");
  }
  const milliseconds = Number(creationDate);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error("Comprehensive provider index creation time is invalid");
  }
  return new Date(milliseconds).toISOString();
}

async function requestJson(pathname, init) {
  const headers = new Headers(init?.headers);
  if (providerAuthorization) headers.set("authorization", providerAuthorization);
  const response = await fetch(new URL(pathname, `${providerBaseUrl}/`), {
    ...init,
    headers
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Comprehensive provider returned HTTP ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Comprehensive provider returned invalid JSON");
  }
}

function semanticVectorIndexUid(input) {
  const digest = createHash("sha256")
    .update([
      input.knowledgeBaseId,
      input.semanticGenerationPublicId,
      input.mappingFingerprintSha256
    ].join("\u001f"))
    .digest("hex")
    .slice(0, 48);
  return `${input.indexPrefix}-semantic-${digest}`;
}

function isoTimestamp(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Comprehensive provider database timestamp is invalid");
  }
  return parsed.toISOString();
}

function mergeRetainedIndexes(indexes) {
  const merged = new Map();
  for (const index of indexes) {
    const existing = merged.get(index.indexUid);
    if (existing && existing.documentCount !== index.documentCount) {
      throw new Error("Comprehensive provider retained index counts conflict");
    }
    merged.set(index.indexUid, index);
  }
  return [...merged.values()].sort((left, right) =>
    left.indexUid.localeCompare(right.indexUid, "en"));
}

function stableJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stableJson(item))));
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => [key, JSON.parse(stableJson(item))])));
}

function writePrivateReport(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
