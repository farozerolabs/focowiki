import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComprehensiveOpenSearchVectorRequest,
  evaluateComprehensiveVectorQuery,
  inspectComprehensiveVectorArtifact,
  retryComprehensiveVectorSourceHydration
} from "../lib/comprehensive-vector-oracle.mjs";

test("retries source hydration on 429 using the bounded Retry-After delay", async () => {
  const delays = [];
  let calls = 0;
  const result = await retryComprehensiveVectorSourceHydration(async () => {
    calls += 1;
    return calls === 1
      ? { status: 429, retryAfterMs: 2_000 }
      : { status: 200, retryAfterMs: null };
  }, {
    sleep: async (milliseconds) => delays.push(milliseconds)
  });

  assert.deepEqual(result, {
    status: 200,
    retryAfterMs: null,
    attempts: 2
  });
  assert.deepEqual(delays, [2_000]);

  const rejected = await retryComprehensiveVectorSourceHydration(async () => ({
    status: 403,
    retryAfterMs: null
  }));
  assert.equal(rejected.attempts, 1);
  assert.equal(rejected.status, 403);
});

test("builds the exact scoped OpenSearch cosine KNN request", () => {
  assert.deepEqual(buildComprehensiveOpenSearchVectorRequest({
    knowledgeBaseId: "knowledge-base-1",
    semanticGenerationPublicId: "semantic-generation-1",
    embeddingConfigurationRevisionPublicId: "embedding-revision-1",
    family: "entity",
    vector: [0.6, 0.8],
    threshold: 0.42,
    requestedK: 5
  }), {
    _source: ["id", "ownerPublicId"],
    size: 5,
    track_total_hits: false,
    query: {
      knn: {
        vector: {
          vector: [0.6, 0.8],
          min_score: 0.71,
          filter: {
            bool: {
              filter: [
                { term: { knowledgeBaseId: "knowledge-base-1" } },
                { term: { semanticGenerationPublicId: "semantic-generation-1" } },
                { term: {
                  embeddingConfigurationRevisionPublicId: "embedding-revision-1"
                } },
                { term: { family: "entity" } }
              ]
            }
          }
        }
      }
    }
  });
});

test("inspects every vector artifact without retaining raw vector values", () => {
  assert.deepEqual(inspectComprehensiveVectorArtifact({
    artifactPublicId: "artifact-1",
    vectorDocumentId: "vector-1",
    ownerPublicId: "owner-1",
    sourceFilePublicId: "source-1",
    family: "content",
    embeddingConfigurationRevisionPublicId: "embedding-revision-1",
    dimension: 2,
    normalization: "l2",
    vectorChecksumSha256: "a".repeat(64),
    objectChecksumSha256: "a".repeat(64),
    byteCount: 24,
    vector: [0.6, 0.8],
    providerOwnerMatched: true,
    sourceOwnerMatched: true,
    s3OwnerMatched: true,
    reuseDisposition: "active",
    deletionDisposition: "not_deleted"
  }), {
    artifactPublicId: "artifact-1",
    vectorDocumentId: "vector-1",
    ownerPublicId: "owner-1",
    sourceFilePublicId: "source-1",
    family: "content",
    embeddingConfigurationRevisionPublicId: "embedding-revision-1",
    dimension: 2,
    normalization: "l2",
    vectorChecksumSha256: "a".repeat(64),
    objectChecksumSha256: "a".repeat(64),
    byteCount: 24,
    finite: true,
    nonzero: true,
    magnitude: 1,
    normalized: true,
    providerOwnerMatched: true,
    sourceOwnerMatched: true,
    s3OwnerMatched: true,
    reuseDisposition: "active",
    deletionDisposition: "not_deleted",
    ok: true
  });
});

test("compares approximate owners with exact normalized cosine truth", () => {
  const result = evaluateComprehensiveVectorQuery({
    queryId: "query-1",
    querySha256: "b".repeat(64),
    knowledgeBaseId: "knowledge-base-1",
    family: "content",
    dimension: 2,
    threshold: 0.5,
    requestedK: 2,
    queryVector: [1, 0],
    documents: [
      {
        id: "vector-1",
        ownerPublicId: "owner-1",
        sourceFilePublicId: "source-1",
        vector: [1, 0]
      },
      {
        id: "vector-2",
        ownerPublicId: "owner-2",
        sourceFilePublicId: "source-2",
        vector: [0.8, 0.2]
      },
      {
        id: "vector-3",
        ownerPublicId: "owner-3",
        sourceFilePublicId: "source-3",
        vector: [0, 1]
      }
    ],
    approximate: {
      processingTimeMs: 4.5,
      hits: [
        { documentId: "vector-2", ownerPublicId: "owner-2" },
        { documentId: "vector-1", ownerPublicId: "owner-1" }
      ]
    },
    requiredSourceFilePublicId: "source-1",
    sourceHydration: {
      status: 200,
      latencyMs: 1.5,
      sourceFilePublicId: "source-1"
    }
  });

  assert.equal(result.eligibleCount, 3);
  assert.equal(result.exactEligibleCount, 2);
  assert.equal(result.annRecall, 1);
  assert.equal(result.requiredSourcePresentInExact, true);
  assert.equal(result.sourceHydration.ok, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.exactOwners, ["owner-1", "owner-2"]);
  assert.deepEqual(result.approximateOwners, ["owner-2", "owner-1"]);
  assert.equal(Object.hasOwn(result, "queryVector"), false);
  assert.equal(JSON.stringify(result).includes("0.8"), false);
});

test("fails an individual query when the required source is absent or ownership drifts", () => {
  const result = evaluateComprehensiveVectorQuery({
    queryId: "query-2",
    querySha256: "c".repeat(64),
    knowledgeBaseId: "knowledge-base-1",
    family: "content",
    dimension: 2,
    threshold: 0,
    requestedK: 1,
    queryVector: [1, 0],
    documents: [{
      id: "vector-1",
      ownerPublicId: "owner-1",
      sourceFilePublicId: "source-2",
      vector: [1, 0]
    }],
    approximate: {
      processingTimeMs: 1,
      hits: [{ documentId: "vector-1", ownerPublicId: "foreign-owner" }]
    },
    requiredSourceFilePublicId: "source-1",
    sourceHydration: {
      status: 404,
      latencyMs: 1,
      sourceFilePublicId: "source-1"
    }
  });

  assert.equal(result.ownerMatches, false);
  assert.equal(result.requiredSourcePresentInExact, false);
  assert.equal(result.sourceHydration.ok, false);
  assert.equal(result.ok, false);
});

test("does not require every semantic family lane to contain the fused file qrel", () => {
  const result = evaluateComprehensiveVectorQuery({
    queryId: "query-family-independent",
    querySha256: "d".repeat(64),
    knowledgeBaseId: "knowledge-base-1",
    family: "community",
    dimension: 2,
    threshold: 0.5,
    requestedK: 1,
    queryVector: [1, 0],
    documents: [{
      id: "vector-community",
      ownerPublicId: "community-owner",
      sourceFilePublicId: "source-community-evidence",
      vector: [1, 0]
    }],
    approximate: {
      processingTimeMs: 1,
      hits: [{
        documentId: "vector-community",
        ownerPublicId: "community-owner"
      }]
    },
    requiredSourceFilePublicId: "source-fused-qrel",
    sourceHydration: {
      status: 200,
      latencyMs: 1,
      sourceFilePublicId: "source-fused-qrel"
    }
  });

  assert.equal(result.annRecall, 1);
  assert.equal(result.requiredSourcePresentInExact, false);
  assert.equal(result.requiredSourcePresentInApproximate, false);
  assert.equal(result.ok, true);
});
