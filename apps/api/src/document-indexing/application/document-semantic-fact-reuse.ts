import { createHash } from "node:crypto";
import type {
  SemanticDesiredFactSet,
  SemanticSourceExtractionManifest
} from "../../semantic/domain/contracts.js";

export function rebaseDocumentSemanticFacts(input: {
  facts: SemanticDesiredFactSet;
  manifest: SemanticSourceExtractionManifest;
  targetSourceRevisionPublicId: string;
  targetSemanticGenerationPublicId?: string;
  targetLogicalPath: string;
}): {
  facts: SemanticDesiredFactSet;
  manifest: SemanticSourceExtractionManifest;
} {
  validateTarget(input.targetSourceRevisionPublicId, input.targetLogicalPath);
  const evidenceIds = new Map(input.facts.evidence.map((evidence) => [
    evidence.publicId,
    stableId(
      "semantic-reused-evidence-v1",
      input.facts.knowledgeBaseId,
      input.targetSourceRevisionPublicId,
      evidence.publicId
    )
  ]));
  const evidence = input.facts.evidence.map((item) => ({
    ...item,
    publicId: requiredMapping(evidenceIds, item.publicId),
    sourceRevisionPublicId: input.targetSourceRevisionPublicId,
    logicalPath: input.targetLogicalPath
  }));
  const mentions = input.facts.mentions.map((item) => ({
    ...item,
    publicId: stableId(
      "semantic-reused-mention-v1",
      input.targetSourceRevisionPublicId,
      item.entityPublicId,
      requiredMapping(evidenceIds, item.evidencePublicId)
    ),
    evidencePublicId: requiredMapping(evidenceIds, item.evidencePublicId),
    sourceRevisionPublicId: input.targetSourceRevisionPublicId
  }));
  const relationships = input.facts.relationships.map((item) => ({
    ...item,
    evidencePublicIds: item.evidencePublicIds.map((publicId) =>
      requiredMapping(evidenceIds, publicId))
  }));
  return {
    facts: {
      ...input.facts,
      semanticGenerationPublicId: input.targetSemanticGenerationPublicId
        ?? input.facts.semanticGenerationPublicId,
      sourceRevisionPublicId: input.targetSourceRevisionPublicId,
      evidence,
      mentions,
      relationships
    },
    manifest: {
      ...input.manifest,
      canonicalInputSha256: stableId(
        "semantic-reused-input-v1",
        input.manifest.canonicalInputSha256,
        input.targetSourceRevisionPublicId
      )
    }
  };
}

function requiredMapping(values: Map<string, string>, publicId: string): string {
  const value = values.get(publicId);
  if (!value) throw reuseError("semantic_evidence_mapping_missing");
  return value;
}

function validateTarget(sourceRevisionPublicId: string, logicalPath: string): void {
  if (!sourceRevisionPublicId || Buffer.byteLength(sourceRevisionPublicId, "utf8") > 255
    || !logicalPath || Buffer.byteLength(logicalPath, "utf8") > 4_096) {
    throw reuseError("semantic_reuse_target_invalid");
  }
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function reuseError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document semantic reuse error: ${code}`), { code });
}
