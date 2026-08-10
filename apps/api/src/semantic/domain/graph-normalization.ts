import { createHash } from "node:crypto";
import {
  SEMANTIC_EXTRACTION_CONTRACT_VERSION,
  type SemanticDesiredFactSet,
  type SemanticEntity,
  type SemanticEvidence,
  type SemanticMention,
  type SemanticRelationship
} from "./contracts.js";

export type GraphRagExtractionRecordSet = {
  entities: readonly {
    entityId: string;
    canonicalName: string;
    normalizedName: string;
    entityType: string;
    descriptions: readonly string[];
  }[];
  mentions: readonly {
    mentionId: string;
    entityId: string;
    sourceFileId: string;
    sourceRevisionId: string;
    evidenceId: string;
  }[];
  relationships: readonly {
    relationshipId: string;
    sourceEntityId: string;
    targetEntityId: string;
    description: string;
    weight: number;
    sourceFileId: string;
    sourceRevisionId: string;
    evidenceId: string;
  }[];
};

export function buildSemanticDesiredFactSet(input: {
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  chunks: readonly { evidenceId: string; text: string; startOffset: number; endOffset: number }[];
  extraction: GraphRagExtractionRecordSet;
}): SemanticDesiredFactSet {
  const chunks = new Map(input.chunks.map((chunk) => [chunk.evidenceId, validateChunk(chunk)]));
  if (chunks.size !== input.chunks.length) throw new Error("Semantic evidence identifiers collide");
  const entityMap = new Map<string, SemanticEntity>();
  const adapterEntityIds = new Map<string, string>();
  for (const raw of input.extraction.entities) {
    const normalizedName = normalizeName(raw.normalizedName);
    if (normalizedName !== normalizeName(raw.canonicalName)) {
      throw new Error("Semantic entity normalization differs from its label");
    }
    const kind = normalizeKind(raw.entityType);
    const canonicalKey = `${kind}:${normalizedName}`;
    const publicId = stableId("semantic-entity", input.knowledgeBaseId, canonicalKey);
    const description = canonicalDescriptions(raw.descriptions);
    const existing = entityMap.get(canonicalKey);
    if (existing) {
      const aliases = new Set([...existing.aliases, raw.canonicalName.trim()]);
      existing.aliases = [...aliases].sort((left, right) => left.localeCompare(right));
      if (description && existing.description && description !== existing.description) {
        existing.description = [existing.description, description].sort().join(" ");
      } else existing.description ??= description;
    } else {
      entityMap.set(canonicalKey, {
        publicId,
        canonicalKey,
        kind,
        label: raw.canonicalName.trim(),
        description,
        aliases: [raw.canonicalName.trim()],
        extractionContractVersion: SEMANTIC_EXTRACTION_CONTRACT_VERSION,
        confidence: 0,
        provenance: "model",
        revision: 1
      });
    }
    adapterEntityIds.set(requireId(raw.entityId), publicId);
  }

  const requiredEvidenceIds = new Set([
    ...input.extraction.mentions.map((mention) => mention.evidenceId),
    ...input.extraction.relationships.map((relationship) => relationship.evidenceId)
  ]);
  const evidenceByAdapterId = new Map<string, SemanticEvidence>();
  for (const evidenceId of requiredEvidenceIds) {
    const chunk = chunks.get(evidenceId);
    if (!chunk) throw new Error("Semantic fact references evidence outside the source revision");
    evidenceByAdapterId.set(evidenceId, {
      publicId: stableId("semantic-evidence", input.knowledgeBaseId, input.sourceRevisionPublicId, evidenceId),
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      logicalPath: input.logicalPath,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      excerptChecksumSha256: createHash("sha256").update(chunk.text).digest("hex"),
      extractionContractVersion: SEMANTIC_EXTRACTION_CONTRACT_VERSION
    });
  }

  const mentions: SemanticMention[] = input.extraction.mentions.map((raw) => {
    assertSourceOwner(raw, input);
    const entityPublicId = entityMapId(adapterEntityIds, raw.entityId);
    const evidence = requireEvidence(evidenceByAdapterId, raw.evidenceId);
    const entity = [...entityMap.values()].find((candidate) => candidate.publicId === entityPublicId)!;
    return {
      publicId: stableId("semantic-mention", input.sourceRevisionPublicId, entityPublicId, evidence.publicId),
      entityPublicId,
      evidencePublicId: evidence.publicId,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      text: entity.label,
      confidence: 0
    };
  });
  const relationships: SemanticRelationship[] = input.extraction.relationships.map((raw) => {
    assertSourceOwner(raw, input);
    const fromEntityPublicId = entityMapId(adapterEntityIds, raw.sourceEntityId);
    const toEntityPublicId = entityMapId(adapterEntityIds, raw.targetEntityId);
    if (fromEntityPublicId === toEntityPublicId) {
      throw new Error("Semantic relationship cannot target the same canonical entity");
    }
    const evidence = requireEvidence(evidenceByAdapterId, raw.evidenceId);
    const description = requireText(raw.description, 8_192);
    return {
      publicId: stableId("semantic-relationship", input.knowledgeBaseId, fromEntityPublicId, toEntityPublicId, "related_to"),
      fromEntityPublicId,
      toEntityPublicId,
      kind: "related_to",
      description,
      evidencePublicIds: [evidence.publicId],
      confidence: 0,
      provenance: "model",
      revision: 1
    };
  });
  const supportedEntityPublicIds = new Set([
    ...mentions.map((mention) => mention.entityPublicId),
    ...relationships.flatMap((relationship) => [
      relationship.fromEntityPublicId,
      relationship.toEntityPublicId
    ])
  ]);
  for (const entity of entityMap.values()) {
    if (!supportedEntityPublicIds.has(entity.publicId)) {
      throw new Error("Semantic entity has no owned evidence");
    }
  }
  return {
    knowledgeBaseId: input.knowledgeBaseId,
    semanticGenerationPublicId: input.semanticGenerationPublicId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    entities: [...entityMap.values()].sort((left, right) => left.publicId.localeCompare(right.publicId)),
    evidence: [...evidenceByAdapterId.values()].sort((left, right) => left.publicId.localeCompare(right.publicId)),
    mentions: deduplicate(mentions, (item) => item.publicId),
    relationships: mergeRelationships(relationships),
    communities: [],
    communityReports: []
  };
}

function mergeRelationships(values: readonly SemanticRelationship[]): SemanticRelationship[] {
  const result = new Map<string, SemanticRelationship>();
  for (const value of values) {
    const existing = result.get(value.publicId);
    if (!existing) result.set(value.publicId, value);
    else {
      existing.evidencePublicIds = [...new Set([
        ...existing.evidencePublicIds,
        ...value.evidencePublicIds
      ])].sort();
      if (value.description && existing.description !== value.description) {
        existing.description = [existing.description, value.description]
          .filter((item): item is string => Boolean(item))
          .sort()
          .join(" ");
      }
    }
  }
  return [...result.values()].sort((left, right) => left.publicId.localeCompare(right.publicId));
}

function validateChunk(chunk: { evidenceId: string; text: string; startOffset: number; endOffset: number }) {
  requireId(chunk.evidenceId);
  if (
    !chunk.text
    || chunk.text.length > 64_000
    || !Number.isInteger(chunk.startOffset)
    || !Number.isInteger(chunk.endOffset)
    || chunk.startOffset < 0
    || chunk.endOffset < chunk.startOffset
  ) throw new Error("Semantic evidence chunk is invalid");
  return chunk;
}

function assertSourceOwner(
  value: { sourceFileId: string; sourceRevisionId: string },
  expected: { sourceFilePublicId: string; sourceRevisionPublicId: string }
): void {
  if (
    value.sourceFileId !== expected.sourceFilePublicId
    || value.sourceRevisionId !== expected.sourceRevisionPublicId
  ) throw new Error("Semantic record is outside the source revision owner");
}

function entityMapId(values: Map<string, string>, adapterId: string): string {
  const value = values.get(requireId(adapterId));
  if (!value) throw new Error("Semantic relationship or mention endpoint is unavailable");
  return value;
}

function requireEvidence(values: Map<string, SemanticEvidence>, adapterId: string): SemanticEvidence {
  const value = values.get(adapterId);
  if (!value) throw new Error("Semantic evidence is unavailable");
  return value;
}

function canonicalDescriptions(values: readonly string[]): string | null {
  if (values.length > 64) throw new Error("Semantic entity descriptions exceed their bound");
  const normalized = [...new Set(values.map((value) => requireText(value, 8_192)))].sort();
  const joined = normalized.join(" ");
  if (joined.length > 8_192) throw new Error("Semantic entity description exceeds its bound");
  return joined || null;
}

function normalizeName(value: string): string {
  return requireText(value, 1_024).normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en");
}

function normalizeKind(value: string): string {
  return requireText(value, 128).normalize("NFKC").trim().toLocaleLowerCase("en");
}

function requireText(value: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error("Semantic text is invalid");
  }
  return value.trim();
}

function requireId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value)) {
    throw new Error("Semantic identifier is invalid");
  }
  return value;
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function deduplicate<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()]
    .sort((left, right) => key(left).localeCompare(key(right)));
}
