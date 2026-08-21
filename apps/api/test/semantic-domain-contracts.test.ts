import { describe, expect, it } from "vitest";
import type {
  EmbeddingArtifactIdentity,
  SemanticAffectedClosure,
  SemanticDesiredFactSet,
  SemanticMaintenanceTarget
} from "../src/semantic/domain/contracts.js";
import {
  SEMANTIC_EXTRACTION_CONTRACT_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION
} from "../src/semantic/domain/contracts.js";
import {
  assertEmbeddingArtifactIdentity,
  assertSemanticAffectedClosure,
  assertSemanticDesiredFactSet,
  assertSemanticMaintenanceTarget
} from "../src/semantic/domain/validation.js";
import { buildSemanticAffectedClosure } from
  "../src/semantic/infrastructure/postgres-fact-closure.js";

describe("Focowiki-owned semantic contracts", () => {
  it("uses only the destructive sparse-skeleton extraction baseline", () => {
    expect(SEMANTIC_EXTRACTION_CONTRACT_VERSION)
      .toBe("semantic-skeleton-v2");
    expect(SEMANTIC_PROMPT_CONTRACT_VERSION).toBe("general-purpose-graph-v3");
    expect(SEMANTIC_EXTRACTION_CONTRACT_VERSION).not.toContain("v1");
  });

  it("accepts a bounded evidence-owned desired fact set", () => {
    expect(() => assertSemanticDesiredFactSet(desiredFacts())).not.toThrow();
  });

  it("rejects foreign evidence, duplicate identities, invalid confidence, and self edges", () => {
    const foreign = desiredFacts();
    foreign.evidence = [{ ...foreign.evidence[0]!, sourceRevisionPublicId: "other" }];
    expect(() => assertSemanticDesiredFactSet(foreign)).toThrow("evidence ownership");

    const duplicate = desiredFacts();
    duplicate.entities = [duplicate.entities[0]!, duplicate.entities[0]!];
    expect(() => assertSemanticDesiredFactSet(duplicate)).toThrow("duplicate");

    const invalidConfidence = desiredFacts();
    invalidConfidence.entities = [{ ...invalidConfidence.entities[0]!, confidence: 2 }];
    expect(() => assertSemanticDesiredFactSet(invalidConfidence)).toThrow("confidence");

    const selfEdge = desiredFacts();
    selfEdge.relationships = [{
      ...selfEdge.relationships[0]!,
      toEntityPublicId: selfEdge.relationships[0]!.fromEntityPublicId
    }];
    expect(() => assertSemanticDesiredFactSet(selfEdge)).toThrow("endpoints");
  });

  it("bounds affected closures without prescribing a domain ontology", () => {
    const closure: SemanticAffectedClosure = {
      knowledgeBaseId: "kb-semantic",
      sourceFilePublicIds: ["file-a"],
      sourceRevisionPublicIds: ["revision-a"],
      entityPublicIds: ["entity-a"],
      relationshipPublicIds: ["relationship-a"],
      evidencePublicIds: ["evidence-a"],
      reverseReferencePublicIds: ["reverse-a"],
      vectorOwnerPublicIds: ["entity-a"],
      dirtyPartitionKeys: ["partition-a"],
      affectedFileNeighborPublicIds: ["file-b"],
      generatedLogicalPaths: ["pages/a.md"],
      graphShardPublicIds: ["graph-shard-a"],
      searchShardPublicIds: ["search-shard-a"]
    };
    expect(() => assertSemanticAffectedClosure(closure)).not.toThrow();
    expect(Object.keys(closure)).not.toContain("caseType");
  });

  it("projects semantic evidence paths into the generated pages namespace", async () => {
    const input = desiredFacts();
    input.entities = [];
    input.relationships = [];
    input.mentions = [];
    input.evidence = [{
      ...input.evidence[0]!,
      logicalPath: "guides/alpha.md"
    }];

    const closure = await buildSemanticAffectedClosure(undefined as never, input, {
      sourceRevisionPublicIds: [],
      entityPublicIds: [],
      relationshipPublicIds: [],
      evidencePublicIds: []
    });

    expect(closure.generatedLogicalPaths).toEqual([
      "_graph/by-file/guides/alpha.json",
      "pages/guides/alpha.md"
    ]);
  });

  it("pins artifact and maintenance identity to dimension and model revision", () => {
    const artifact: EmbeddingArtifactIdentity = {
      knowledgeBaseId: "kb-semantic",
      ownerKind: "entity",
      ownerPublicId: "entity-a",
      sourceRevisionPublicId: "revision-a",
      canonicalInputSha256: "a".repeat(64),
      embeddingConfigurationRevisionPublicId: "embedding-revision-a",
      normalization: "l2",
      dimension: 8,
      inputKind: "entity",
      artifactSchemaVersion: "vector-v1"
    };
    expect(() => assertEmbeddingArtifactIdentity(artifact)).not.toThrow();
    expect(() => assertEmbeddingArtifactIdentity({
      ...artifact,
      inputKind: "content"
    })).toThrow("kinds must match");

    const target: SemanticMaintenanceTarget = {
      knowledgeBaseId: "kb-semantic",
      generationModelConfigurationPublicId: "model-config-a",
      generationModelConfigurationRevision: 1,
      extractionContractVersion: "extract-v1",
      graphSchemaVersion: "graph-v1",
      promptContractVersion: "prompt-v1",
      embeddingConfigurationRevisionPublicId: "embedding-revision-a",
      embeddingQueryPolicyRevisionPublicId: "embedding-revision-a",
      minimumVectorRelevance: 0.7,
      resolvedDimension: 8,
      normalization: "l2",
      artifactSchemaVersion: "artifact-v1",
      vectorSchemaVersion: "vector-v1",
      searchProviderKind: "opensearch",
      mappingFingerprintSha256: "b".repeat(64)
    };
    expect(() => assertSemanticMaintenanceTarget(target)).not.toThrow();
  });
});

function desiredFacts(): SemanticDesiredFactSet {
  return {
    knowledgeBaseId: "kb-semantic",
    semanticGenerationPublicId: "semantic-generation-a",
    sourceFilePublicId: "file-a",
    sourceRevisionPublicId: "revision-a",
    entities: [{
      publicId: "entity-a",
      canonicalKey: "concept:alpha",
      kind: "concept",
      label: "Alpha",
      description: "A general concept.",
      aliases: ["A"],
      extractionContractVersion: "extract-v1",
      confidence: 0.9,
      provenance: "model",
      revision: 1
    }, {
      publicId: "entity-b",
      canonicalKey: "concept:beta",
      kind: "concept",
      label: "Beta",
      description: null,
      aliases: [],
      extractionContractVersion: "extract-v1",
      confidence: 1,
      provenance: "deterministic",
      revision: 1
    }],
    evidence: [{
      publicId: "evidence-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/a.md",
      startOffset: 0,
      endOffset: 5,
      excerptChecksumSha256: "c".repeat(64),
      extractionContractVersion: "extract-v1"
    }],
    mentions: [{
      publicId: "mention-a",
      entityPublicId: "entity-a",
      evidencePublicId: "evidence-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      text: "Alpha",
      confidence: 0.9
    }],
    relationships: [{
      publicId: "relationship-a",
      fromEntityPublicId: "entity-a",
      toEntityPublicId: "entity-b",
      kind: "related_to",
      description: "Alpha is related to Beta.",
      evidencePublicIds: ["evidence-a"],
      confidence: 0.8,
      provenance: "model",
      revision: 1
    }],
    communities: [],
    communityReports: []
  };
}
