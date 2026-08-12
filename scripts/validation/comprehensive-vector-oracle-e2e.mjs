#!/usr/bin/env node

import { createDecipheriv, createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  buildComprehensiveOpenSearchVectorRequest,
  evaluateComprehensiveVectorQuery,
  inspectComprehensiveVectorArtifact,
  retryComprehensiveVectorSourceHydration
} from "./lib/comprehensive-vector-oracle.mjs";
import {
  parseRetryAfterMilliseconds
} from "./lib/comprehensive-search-ledger.mjs";

const require = createRequire(path.resolve(
  process.env.FOCOWIKI_API_PACKAGE_PATH?.trim() || "apps/api/package.json"
));
const postgres = require("postgres");
const { GetObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const reportInputPath = path.resolve(requiredEnv("FOCOWIKI_VECTOR_QUERY_LEDGER"));
const reportPath = path.resolve(requiredEnv("FOCOWIKI_VECTOR_ORACLE_REPORT"));
const provider = requiredEnv("SEARCH_PROVIDER");
if (provider !== "meilisearch" && provider !== "opensearch") {
  throw new Error("Comprehensive vector oracle provider is unsupported");
}
const sql = postgres(runtimeDatabaseUrl(), {
  max: 4,
  connect_timeout: 10,
  idle_timeout: 10,
  prepare: false
});
const s3 = new S3Client({
  endpoint: runtimeS3Endpoint(),
  region: requiredEnv("S3_REGION"),
  credentials: {
    accessKeyId: requiredEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("S3_SECRET_ACCESS_KEY")
  },
  forcePathStyle: requiredEnv("S3_FORCE_PATH_STYLE") === "true"
});
const queryLedger = readJson(reportInputPath);
const queryCases = queryLedger.rows.map((row) => {
  const query = row.queries.find((item) => item.variant === "natural_sentence_hybrid");
  if (!query?.query || !query?.querySha256 || !row.sourceFileId) {
    throw new Error(`Comprehensive vector oracle query is incomplete: ${row.alias}`);
  }
  return {
    queryId: `${row.alias}:natural_sentence_hybrid`,
    query: query.query,
    querySha256: query.querySha256,
    knowledgeBaseId: row.knowledgeBaseId,
    sourceFilePublicId: row.sourceFileId,
    contentPath: query.fileContentById
  };
});
if (queryCases.length !== 200 || new Set(queryCases.map((item) => item.queryId)).size !== 200) {
  throw new Error("Comprehensive vector oracle requires exactly 200 unique query cases");
}

const report = {
  format: "focowiki-comprehensive-vector-oracle-v1",
  provider,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  counts: {
    sourceFiles: queryCases.length,
    vectorArtifacts: 0,
    vectorQueries: 0,
    successfulVectorQueries: 0,
    failedVectorQueries: 0,
    hydratedSources: 0
  },
  artifactSummary: null,
  querySummary: null,
  artifacts: [],
  queries: [],
  failures: [],
  cleanup: { temporaryOpenApiKeyDeleted: true }
};

let temporaryKeyId = null;
let adminClient = null;
try {
  const database = await readDatabaseVectors();
  const artifactVectors = await mapWithConcurrency(database.vectors, 16, readArtifact);
  report.artifacts = artifactVectors.map((item) => item.evidence);
  report.counts.vectorArtifacts = report.artifacts.length;
  const invalidArtifacts = report.artifacts.filter((item) => !item.ok);
  invalidArtifacts.forEach((item) => report.failures.push({
    kind: "artifact",
    id: item.vectorDocumentId,
    code: "vector_artifact_invalid"
  }));
  report.artifactSummary = summarizeArtifacts(report.artifacts);

  const activeEmbedding = await readActiveEmbeddingConfiguration();
  const queryVectorByText = await embedQueries(activeEmbedding, queryCases);
  const authorization = await createTemporaryOpenApiKey();
  temporaryKeyId = authorization.keyId;
  report.cleanup.temporaryOpenApiKeyDeleted = false;
  const documentsByScope = Map.groupBy(artifactVectors, (item) =>
    `${item.database.knowledgeBaseId}\u001f${item.database.family}`);
  for (const queryCase of queryCases) {
    const families = [...new Set(database.vectors
      .filter((item) => item.knowledgeBaseId === queryCase.knowledgeBaseId)
      .map((item) => item.family))].sort((left, right) => left.localeCompare(right, "en"));
    for (const family of families) {
      const documents = documentsByScope.get(
        `${queryCase.knowledgeBaseId}\u001f${family}`
      ) ?? [];
      const queryVector = queryVectorByText.get(queryCase.query);
      if (!queryVector) throw new Error("Comprehensive vector oracle query vector is unavailable");
      const knowledgeBase = database.knowledgeBases.get(queryCase.knowledgeBaseId);
      if (!knowledgeBase) throw new Error("Comprehensive vector oracle knowledge base is unavailable");
      const approximate = await queryProvider({
        knowledgeBase,
        family,
        vector: queryVector,
        threshold: activeEmbedding.minimumVectorRelevance,
        requestedK: Math.min(50, documents.length)
      });
      const sourceHydration = await hydrateSource(
        queryCase,
        authorization.rawKey
      );
      const observation = evaluateComprehensiveVectorQuery({
        queryId: queryCase.queryId,
        querySha256: queryCase.querySha256,
        knowledgeBaseId: queryCase.knowledgeBaseId,
        family,
        dimension: activeEmbedding.resolvedDimension,
        threshold: activeEmbedding.minimumVectorRelevance,
        requestedK: Math.min(50, documents.length),
        queryVector,
        documents: documents.map((document) => ({
          id: document.database.vectorDocumentId,
          ownerPublicId: document.database.ownerPublicId,
          sourceFilePublicId: document.database.sourceFilePublicId,
          vector: document.vector
        })),
        approximate,
        requiredSourceFilePublicId: queryCase.sourceFilePublicId,
        sourceHydration
      });
      report.queries.push(observation);
      report.counts.vectorQueries += 1;
      report.counts.hydratedSources += sourceHydration.status === 200 ? 1 : 0;
      if (observation.ok) report.counts.successfulVectorQueries += 1;
      else {
        report.counts.failedVectorQueries += 1;
        report.failures.push({
          kind: "query",
          id: `${queryCase.queryId}:${family}`,
          code: "vector_query_oracle_mismatch",
          ownerMatches: observation.ownerMatches,
          requiredSourcePresentInExact: observation.requiredSourcePresentInExact,
          requiredSourcePresentInApproximate:
            observation.requiredSourcePresentInApproximate,
          sourceHydration: observation.sourceHydration.ok
        });
      }
    }
    process.stdout.write(
      `vector-oracle ${provider}: ${report.queries.length} query-family rows\n`
    );
    writePrivateReport(reportPath, report);
  }
  report.querySummary = summarizeQueries(report.queries);
  report.ok = report.failures.length === 0
    && report.artifacts.length === database.vectors.length
    && report.counts.vectorQueries === report.counts.successfulVectorQueries;
} finally {
  if (temporaryKeyId) {
    report.cleanup.temporaryOpenApiKeyDeleted = await deleteTemporaryOpenApiKey(
      temporaryKeyId
    );
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.ok && report.cleanup.temporaryOpenApiKeyDeleted;
  writePrivateReport(reportPath, report);
  await sql.end({ timeout: 5 });
  s3.destroy();
}

process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  reportPath,
  counts: report.counts,
  artifactSummary: report.artifactSummary,
  querySummary: report.querySummary,
  failureCount: report.failures.length,
  cleanup: report.cleanup
})}\n`);

async function readDatabaseVectors() {
  const rows = await sql`
    SELECT vector.knowledge_base_id,
           vector.semantic_generation_public_id,
           vector.public_id AS vector_document_id,
           vector.embedding_configuration_revision_public_id,
           vector.artifact_public_id,
           vector.vector_family,
           vector.owner_public_id,
           vector.source_file_public_id,
           vector.source_revision_public_id,
           vector.evidence_target_path,
           vector.dimension,
           vector.provider_document_id,
           contract.mapping_fingerprint_sha256,
           artifact.object_id,
           artifact.normalization,
           artifact.vector_checksum_sha256,
           artifact.byte_count AS artifact_byte_count,
           artifact.state AS artifact_state,
           artifact.deleted_at AS artifact_deleted_at,
           object.storage_key,
           object.checksum_sha256 AS object_checksum_sha256,
           object.byte_count AS object_byte_count,
           object.content_type,
           object.object_format,
           object.state AS object_state,
           EXISTS (
             SELECT 1 FROM focowiki.object_owners owner
             WHERE owner.object_id = artifact.object_id
               AND owner.owner_kind = 'embedding_artifact'
               AND owner.embedding_artifact_public_id = artifact.public_id
           ) AS object_owner_matched,
           EXISTS (
             SELECT 1 FROM focowiki.embedding_artifact_owners owner
             WHERE owner.knowledge_base_id = vector.knowledge_base_id
               AND owner.artifact_public_id = vector.artifact_public_id
               AND owner.semantic_generation_public_id
                 = vector.semantic_generation_public_id
               AND owner.owner_kind = vector.vector_family
               AND owner.owner_public_id = vector.owner_public_id
           ) AS artifact_owner_matched,
           EXISTS (
             SELECT 1 FROM focowiki.semantic_embedding_artifact_refs reference
             WHERE reference.knowledge_base_id = vector.knowledge_base_id
               AND reference.semantic_generation_public_id
                 = vector.semantic_generation_public_id
               AND reference.artifact_public_id = vector.artifact_public_id
               AND reference.semantic_owner_kind = vector.vector_family
               AND reference.semantic_owner_public_id = vector.owner_public_id
               AND reference.source_file_public_id = vector.source_file_public_id
           ) AS artifact_reference_matched,
           EXISTS (
             SELECT 1
             FROM focowiki.source_file_current_revisions current
             JOIN focowiki.source_files source
               ON source.knowledge_base_id = current.knowledge_base_id
              AND source.public_id = current.source_file_public_id
              AND source.status = 'ready'
              AND source.deleted_at IS NULL
             WHERE current.knowledge_base_id = vector.knowledge_base_id
               AND current.source_file_public_id = vector.source_file_public_id
               AND current.source_revision_public_id = vector.source_revision_public_id
               AND source.logical_path = vector.evidence_target_path
           ) AS source_owner_matched
    FROM focowiki.active_snapshots snapshot
    JOIN focowiki.semantic_generations generation
      ON generation.knowledge_base_id = snapshot.knowledge_base_id
     AND generation.generation_role = 'active'
     AND generation.state = 'active'
     AND generation.deleted_at IS NULL
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = generation.knowledge_base_id
     AND contract.semantic_generation_public_id = generation.public_id
    JOIN focowiki.semantic_vector_documents vector
      ON vector.knowledge_base_id = generation.knowledge_base_id
     AND vector.semantic_generation_public_id = generation.public_id
     AND vector.state = 'active'
     AND vector.deleted_at IS NULL
    JOIN focowiki.embedding_artifacts artifact
      ON artifact.public_id = vector.artifact_public_id
     AND artifact.knowledge_base_id = vector.knowledge_base_id
    JOIN focowiki.object_registrations object
      ON object.object_id = artifact.object_id
    ORDER BY vector.knowledge_base_id COLLATE "C",
             vector.vector_family COLLATE "C",
             vector.provider_document_id COLLATE "C"
  `;
  if (rows.length === 0) throw new Error("Comprehensive vector oracle has no active vectors");
  const vectors = rows.map((row) => ({
    knowledgeBaseId: row.knowledge_base_id,
    semanticGenerationPublicId: row.semantic_generation_public_id,
    vectorDocumentId: row.provider_document_id,
    embeddingConfigurationRevisionPublicId:
      row.embedding_configuration_revision_public_id,
    artifactPublicId: row.artifact_public_id,
    family: row.vector_family,
    ownerPublicId: row.owner_public_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    evidenceTargetPath: row.evidence_target_path,
    dimension: Number(row.dimension),
    mappingFingerprintSha256: row.mapping_fingerprint_sha256,
    objectId: row.object_id,
    normalization: row.normalization,
    vectorChecksumSha256: row.vector_checksum_sha256,
    byteCount: Number(row.artifact_byte_count),
    storageKey: row.storage_key,
    objectChecksumSha256: row.object_checksum_sha256,
    objectByteCount: Number(row.object_byte_count),
    contentType: row.content_type,
    objectFormat: row.object_format,
    objectState: row.object_state,
    artifactState: row.artifact_state,
    artifactDeletedAt: row.artifact_deleted_at,
    objectOwnerMatched: row.object_owner_matched,
    artifactOwnerMatched: row.artifact_owner_matched,
    artifactReferenceMatched: row.artifact_reference_matched,
    sourceOwnerMatched: row.source_owner_matched
  }));
  const knowledgeBases = new Map();
  for (const vector of vectors) {
    const existing = knowledgeBases.get(vector.knowledgeBaseId);
    const value = {
      knowledgeBaseId: vector.knowledgeBaseId,
      semanticGenerationPublicId: vector.semanticGenerationPublicId,
      embeddingConfigurationRevisionPublicId:
        vector.embeddingConfigurationRevisionPublicId,
      mappingFingerprintSha256: vector.mappingFingerprintSha256,
      vectorIndexUid: semanticVectorIndexUid(vector)
    };
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new Error("Comprehensive vector oracle knowledge-base contract drifted");
    }
    knowledgeBases.set(vector.knowledgeBaseId, value);
  }
  return { vectors, knowledgeBases };
}

async function readArtifact(database) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: requiredEnv("S3_BUCKET"),
    Key: database.storageKey
  }));
  const bytes = new Uint8Array(await response.Body.transformToByteArray());
  const vector = decodeVectorArtifact({
    bytes,
    checksumSha256: database.vectorChecksumSha256,
    dimension: database.dimension,
    normalization: database.normalization,
    maximumBytes: database.byteCount
  });
  const evidence = inspectComprehensiveVectorArtifact({
    artifactPublicId: database.artifactPublicId,
    vectorDocumentId: database.vectorDocumentId,
    ownerPublicId: database.ownerPublicId,
    sourceFilePublicId: database.sourceFilePublicId,
    family: database.family,
    embeddingConfigurationRevisionPublicId:
      database.embeddingConfigurationRevisionPublicId,
    dimension: database.dimension,
    normalization: database.normalization,
    vectorChecksumSha256: database.vectorChecksumSha256,
    objectChecksumSha256: database.objectChecksumSha256,
    byteCount: database.byteCount,
    vector,
    providerOwnerMatched: database.artifactOwnerMatched
      && database.artifactReferenceMatched,
    sourceOwnerMatched: database.sourceOwnerMatched,
    s3OwnerMatched: database.objectOwnerMatched
      && database.objectState === "verified"
      && database.objectChecksumSha256 === database.vectorChecksumSha256
      && database.objectByteCount === database.byteCount
      && database.contentType === "application/octet-stream"
      && database.objectFormat === "semantic-vector-v1",
    reuseDisposition: database.artifactState === "verified" ? "active" : database.artifactState,
    deletionDisposition: database.artifactDeletedAt === null
      ? "not_deleted" : "deleted"
  });
  return { database, vector, evidence };
}

async function readActiveEmbeddingConfiguration() {
  const rows = await sql`
    SELECT revision.public_id,
           revision.authentication_mode,
           revision.base_url,
           revision.encrypted_api_key,
           revision.model_name,
           revision.requested_dimension,
           revision.resolved_dimension,
           revision.normalization,
           revision.batch_size,
           revision.timeout_ms,
           revision.retry_count,
           revision.minimum_interval_ms,
           revision.maximum_response_bytes,
           revision.minimum_vector_relevance
    FROM focowiki.embedding_configurations configuration
    JOIN focowiki.embedding_configuration_revisions revision
      ON revision.public_id = configuration.active_revision_public_id
    WHERE configuration.lifecycle_status = 'active'
      AND configuration.deleted_at IS NULL
      AND revision.validation_status = 'valid'
  `;
  if (rows.length !== 1) {
    throw new Error("Comprehensive vector oracle requires one active embedding configuration");
  }
  const row = rows[0];
  return {
    revisionPublicId: row.public_id,
    authenticationMode: row.authentication_mode,
    baseUrl: row.base_url,
    apiKey: row.encrypted_api_key
      ? decryptRuntimeSecret(String(row.encrypted_api_key)) : null,
    modelName: row.model_name,
    requestedDimension: row.requested_dimension === null
      ? null : Number(row.requested_dimension),
    resolvedDimension: Number(row.resolved_dimension),
    normalization: row.normalization,
    batchSize: Number(row.batch_size),
    timeoutMs: Number(row.timeout_ms),
    retryCount: Number(row.retry_count),
    minimumIntervalMs: Number(row.minimum_interval_ms),
    maximumResponseBytes: Number(row.maximum_response_bytes),
    minimumVectorRelevance: Number(row.minimum_vector_relevance)
  };
}

async function embedQueries(configuration, cases) {
  const unique = [...new Set(cases.map((item) => item.query))];
  const vectors = new Map();
  for (let offset = 0; offset < unique.length; offset += configuration.batchSize) {
    const inputs = unique.slice(offset, offset + configuration.batchSize);
    const batch = await embedWithRetry(configuration, inputs);
    inputs.forEach((value, index) => vectors.set(value, batch[index]));
    if (offset + inputs.length < unique.length && configuration.minimumIntervalMs > 0) {
      await sleep(configuration.minimumIntervalMs);
    }
  }
  return vectors;
}

async function embedWithRetry(configuration, inputs) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), configuration.timeoutMs);
      try {
        const response = await fetch(
          new URL("embeddings", withTrailingSlash(configuration.baseUrl)),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              ...(configuration.authenticationMode === "api_key"
                ? { authorization: `Bearer ${configuration.apiKey}` } : {})
            },
            body: JSON.stringify({
              model: configuration.modelName,
              input: inputs,
              ...(configuration.requestedDimension === null
                ? {} : { dimensions: configuration.requestedDimension })
            }),
            signal: controller.signal
          }
        );
        if (!response.ok) throw new Error(`embedding_http_${response.status}`);
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > configuration.maximumResponseBytes) {
          throw new Error("embedding_response_too_large");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > configuration.maximumResponseBytes) {
          throw new Error("embedding_response_too_large");
        }
        const body = JSON.parse(new TextDecoder().decode(bytes));
        if (!Array.isArray(body.data) || body.data.length !== inputs.length) {
          throw new Error("embedding_response_mismatch");
        }
        return [...body.data].sort((left, right) => left.index - right.index)
          .map((item) => normalizeVector(item.embedding, configuration));
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (attempt >= configuration.retryCount) throw error;
      await sleep(configuration.minimumIntervalMs);
    }
  }
}

function normalizeVector(vector, configuration) {
  if (!Array.isArray(vector) || vector.length !== configuration.resolvedDimension
    || vector.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error("Comprehensive vector oracle embedding response is invalid");
  }
  if (configuration.normalization === "none") return vector;
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error("Comprehensive vector oracle embedding vector is invalid");
  }
  return vector.map((item) => item / magnitude);
}

async function queryProvider(input) {
  return provider === "meilisearch"
    ? queryMeilisearch(input)
    : queryOpenSearch(input);
}

async function queryMeilisearch(input) {
  const startedAt = performance.now();
  const response = await fetch(
    `${runtimeMeilisearchEndpoint()}/indexes/${
      encodeURIComponent(input.knowledgeBase.vectorIndexUid)
    }/search`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${readConfiguredSecret("MEILI_API_KEY", "MEILI_API_KEY_FILE")}`
      },
      body: JSON.stringify({
        q: "",
        filter: [
          `knowledgeBaseId = ${JSON.stringify(input.knowledgeBase.knowledgeBaseId)}`,
          `semanticGenerationPublicId = ${JSON.stringify(
            input.knowledgeBase.semanticGenerationPublicId
          )}`,
          `embeddingConfigurationRevisionPublicId = ${JSON.stringify(
            input.knowledgeBase.embeddingConfigurationRevisionPublicId
          )}`,
          `family = ${JSON.stringify(input.family)}`
        ].join(" AND "),
        limit: input.requestedK,
        attributesToRetrieve: ["id", "ownerPublicId"],
        vector: input.vector,
        hybrid: {
          embedder: `focowiki_${input.knowledgeBase.mappingFingerprintSha256}`,
          semanticRatio: 1
        },
        rankingScoreThreshold: (input.threshold + 1) / 2
      })
    }
  );
  if (!response.ok) {
    throw new Error(`Comprehensive vector oracle provider query failed: ${response.status}`);
  }
  const body = await response.json();
  return {
    processingTimeMs: Number(body.processingTimeMs ?? performance.now() - startedAt),
    hits: (body.hits ?? []).map((hit) => ({
      documentId: hit.id,
      ownerPublicId: hit.ownerPublicId
    }))
  };
}

async function queryOpenSearch(input) {
  const startedAt = performance.now();
  const headers = {
    "content-type": "application/json",
    ...(process.env.FOCOWIKI_COMPREHENSIVE_OPENSEARCH_AUTHORIZATION?.trim()
      ? { authorization: process.env
          .FOCOWIKI_COMPREHENSIVE_OPENSEARCH_AUTHORIZATION.trim() }
      : {})
  };
  const response = await fetch(
    `${runtimeOpenSearchEndpoint()}/${
      encodeURIComponent(input.knowledgeBase.vectorIndexUid)
    }/_search`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(buildComprehensiveOpenSearchVectorRequest({
        knowledgeBaseId: input.knowledgeBase.knowledgeBaseId,
        semanticGenerationPublicId:
          input.knowledgeBase.semanticGenerationPublicId,
        embeddingConfigurationRevisionPublicId:
          input.knowledgeBase.embeddingConfigurationRevisionPublicId,
        family: input.family,
        vector: input.vector,
        threshold: input.threshold,
        requestedK: input.requestedK
      }))
    }
  );
  if (!response.ok) {
    throw new Error(
      `Comprehensive vector oracle provider query failed: ${response.status}`
    );
  }
  const body = await response.json();
  if (body.timed_out === true || !Array.isArray(body.hits?.hits)) {
    throw new Error("Comprehensive vector oracle OpenSearch result is invalid");
  }
  return {
    processingTimeMs: Number(body.took ?? performance.now() - startedAt),
    hits: body.hits.hits.map((hit) => ({
      documentId: hit._source?.id ?? hit._id,
      ownerPublicId: hit._source?.ownerPublicId
    }))
  };
}

async function createTemporaryOpenApiKey() {
  const client = createAdminClient();
  await client.json("/admin/api/login", {
    method: "POST",
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
  const created = await client.json("/admin/api/openapi-keys", {
    method: "POST",
    json: { name: "Comprehensive vector oracle" },
    expectedStatus: 201
  });
  if (!created.key?.id || !created.oneTimeKey?.rawKey) {
    throw new Error("Comprehensive vector oracle temporary key is incomplete");
  }
  adminClient = client;
  return { keyId: created.key.id, rawKey: created.oneTimeKey.rawKey };
}

async function deleteTemporaryOpenApiKey(keyId) {
  if (!adminClient) return false;
  try {
    await adminClient.json(`/admin/api/openapi-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE"
    });
    return true;
  } catch {
    return false;
  }
}

async function hydrateSource(queryCase, rawKey) {
  const startedAt = performance.now();
  const observation = await retryComprehensiveVectorSourceHydration(async () => {
    const response = await fetch(
      new URL(queryCase.contentPath, runtimePublicOpenApiEndpoint()),
      { headers: { authorization: `Bearer ${rawKey}` } }
    );
    await response.arrayBuffer();
    return {
      status: response.status,
      retryAfterMs: parseRetryAfterMilliseconds(response.headers.get("retry-after"))
    };
  });
  return {
    status: observation.status,
    latencyMs: performance.now() - startedAt,
    attempts: observation.attempts,
    sourceFilePublicId: queryCase.sourceFilePublicId
  };
}

function createAdminClient() {
  let cookie = "";
  const origin = requiredEnv("ADMIN_PUBLIC_ORIGIN");
  return {
    async json(pathname, options = {}) {
      const response = await fetch(new URL(pathname, runtimeAdminApiEndpoint()), {
        method: options.method ?? "GET",
        headers: {
          origin,
          ...(cookie ? { cookie } : {}),
          ...(options.json === undefined ? {} : { "content-type": "application/json" })
        },
        body: options.json === undefined ? undefined : JSON.stringify(options.json)
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0] ?? "";
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      const expected = options.expectedStatus ?? 200;
      if (response.status !== expected) {
        throw new Error(`Comprehensive vector oracle Admin request failed: ${response.status}`);
      }
      return body;
    }
  };
}

function decodeVectorArtifact(input) {
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength > input.maximumBytes
    || bytes.byteLength !== 16 + input.dimension * 4
    || sha256(bytes) !== input.checksumSha256
    || bytes.subarray(0, 8).toString("ascii") !== "FWVEC001"
    || bytes.readUInt32LE(8) !== input.dimension
    || bytes.readUInt8(12) !== (input.normalization === "l2" ? 1 : 0)
    || bytes.subarray(13, 16).some((value) => value !== 0)) {
    throw new Error("Comprehensive vector oracle artifact integrity failed");
  }
  return Array.from({ length: input.dimension }, (_, index) =>
    bytes.readFloatLE(16 + index * 4));
}

function decryptRuntimeSecret(encrypted) {
  const secret = fs.readFileSync(
    process.env.FOCOWIKI_DEPLOYMENT_KEY_FILE?.trim()
      || "/app/runtime-secrets/deployment.key",
    "utf8"
  ).trim();
  const [version, iv, tag, value] = encrypted.split(":");
  if (version !== "v1" || !iv || !tag || !value) {
    throw new Error("Comprehensive vector oracle encrypted secret is invalid");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(secret).digest(),
    Buffer.from(iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(value, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function semanticVectorIndexUid(input) {
  const digest = createHash("sha256").update([
    input.knowledgeBaseId,
    input.semanticGenerationPublicId,
    input.mappingFingerprintSha256
  ].join("\u001f")).digest("hex").slice(0, 48);
  return `${requiredEnv("SEARCH_INDEX_PREFIX")}-semantic-${digest}`;
}

function summarizeArtifacts(artifacts) {
  return {
    total: artifacts.length,
    passed: artifacts.filter((item) => item.ok).length,
    failed: artifacts.filter((item) => !item.ok).length,
    byFamily: countBy(artifacts, (item) => item.family),
    byDimension: countBy(artifacts, (item) => String(item.dimension)),
    normalized: artifacts.filter((item) => item.normalized).length,
    finite: artifacts.filter((item) => item.finite).length
  };
}

function summarizeQueries(queries) {
  const recalls = queries.map((item) => item.annRecall).sort((a, b) => a - b);
  return {
    total: queries.length,
    passed: queries.filter((item) => item.ok).length,
    failed: queries.filter((item) => !item.ok).length,
    byFamily: countBy(queries, (item) => item.family),
    annRecall: {
      minimum: recalls[0] ?? null,
      p50: percentile(recalls, 0.5),
      p95: percentile(recalls, 0.95),
      mean: recalls.length === 0
        ? null : Number((recalls.reduce((sum, value) => sum + value, 0) / recalls.length)
          .toFixed(6))
    },
    exactOracleMs: latencySummary(queries.map((item) => item.exactOracleMs)),
    approximateProviderMs: latencySummary(
      queries.map((item) => item.approximateProviderMs)
    ),
    sourceHydrationMs: latencySummary(
      queries.map((item) => item.sourceHydration.latencyMs)
    )
  };
}

function countBy(values, selector) {
  return Object.fromEntries([...Map.groupBy(values, selector).entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, items]) => [key, items.length]));
}

function latencySummary(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    minimum: sorted[0] ?? null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    maximum: sorted.at(-1) ?? null
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index], index);
    }
  }));
  return results;
}

function readConfiguredSecret(valueField, fileField) {
  const file = process.env[fileField]?.trim();
  if (file) return fs.readFileSync(file, "utf8").trim();
  return requiredEnv(valueField);
}

function withTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function runtimeDatabaseUrl() {
  const url = new URL(requiredEnv("DATABASE_URL"));
  if (process.env.FOCOWIKI_DOCKER_NETWORK === "true") {
    url.hostname = "postgres";
    url.port = "5432";
  }
  return url.toString();
}

function runtimeS3Endpoint() {
  return process.env.FOCOWIKI_DOCKER_NETWORK === "true"
    ? "http://minio:9000"
    : requiredEnv("S3_ENDPOINT");
}

function runtimeMeilisearchEndpoint() {
  return (process.env.FOCOWIKI_DOCKER_NETWORK === "true"
    ? "http://meilisearch:7700"
    : requiredEnv("MEILI_HOST")).replace(/\/$/u, "");
}

function runtimeOpenSearchEndpoint() {
  return (process.env.FOCOWIKI_DOCKER_NETWORK === "true"
    ? "http://opensearch:9200"
    : requiredEnv("FOCOWIKI_COMPREHENSIVE_OPENSEARCH_URL"))
    .replace(/\/$/u, "");
}

function runtimeAdminApiEndpoint() {
  return process.env.FOCOWIKI_DOCKER_NETWORK === "true"
    ? "http://api:43000"
    : "http://127.0.0.1:43000";
}

function runtimePublicOpenApiEndpoint() {
  return process.env.FOCOWIKI_DOCKER_NETWORK === "true"
    ? "http://api:43200"
    : "http://127.0.0.1:43200";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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
