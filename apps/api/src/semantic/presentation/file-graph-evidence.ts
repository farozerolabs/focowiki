import { createHash } from "node:crypto";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphEvidence,
  StorageVnextGraphNodeFact,
  StorageVnextGraphReadPort
} from "../../storage-vnext/graph/ports.js";
import { MAX_STORAGE_VNEXT_GRAPH_EVIDENCE_REFS } from
  "../../storage-vnext/graph/ports.js";

const MAX_PRESENTED_RELATIONSHIPS_PER_EDGE = 4;

export type SemanticFileRelationshipEvidence = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  startOffset: number;
  endOffset: number;
  excerptChecksumSha256: string;
};

export type SemanticFileRelationshipCandidate = {
  targetSourceFilePublicId: string;
  targetSourceRevisionPublicId: string;
  fromEntityLabel: string;
  toEntityLabel: string;
  kind: string;
  description: string | null;
  confidence: number;
  evidence: readonly SemanticFileRelationshipEvidence[];
};

export type SemanticFileRelationshipReadPort = {
  listOutboundCandidates(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    limit: number;
  }): Promise<readonly SemanticFileRelationshipCandidate[]>;
};

export async function loadSemanticFileGraphEdges(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  source: StorageVnextGraphNodeFact;
  relationships: SemanticFileRelationshipReadPort;
  graph: Pick<StorageVnextGraphReadPort, "listNodesBySourceFiles">;
  maximumEdges: number;
}): Promise<StorageVnextGraphEdgeFact[]> {
  const candidates = await input.relationships.listOutboundCandidates({
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId: input.operationPublicId,
    sourceFilePublicId: input.source.sourceFilePublicId,
    sourceRevisionPublicId: input.source.sourceRevisionPublicId,
    limit: input.maximumEdges
  });
  const targetSourceFilePublicIds = [...new Set(candidates.map((candidate) =>
    candidate.targetSourceFilePublicId))];
  const targetNodes = targetSourceFilePublicIds.length === 0 ? []
    : await input.graph.listNodesBySourceFiles({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFilePublicIds: targetSourceFilePublicIds,
        limit: input.maximumEdges
      });
  return planSemanticFileGraphEdges({
    knowledgeBaseId: input.knowledgeBaseId,
    source: input.source,
    targetNodes,
    relationships: candidates,
    maximumEdges: input.maximumEdges
  });
}

export function mergeFileGraphEdges(input: {
  primary: readonly StorageVnextGraphEdgeFact[];
  semantic: readonly StorageVnextGraphEdgeFact[];
  maximumEdges: number;
}): StorageVnextGraphEdgeFact[] {
  if (
    !Number.isSafeInteger(input.maximumEdges)
    || input.maximumEdges < 1
    || input.maximumEdges > 1_000
  ) throw semanticFileGraphError("invalid_input");
  return [...new Map([...input.primary, ...input.semantic].map((edge) =>
    [edge.publicId, edge])).values()]
    .sort((left, right) => right.weight - left.weight
      || compareUtf8(left.publicId, right.publicId))
    .slice(0, input.maximumEdges);
}

export function planSemanticFileGraphEdges(input: {
  knowledgeBaseId: string;
  source: StorageVnextGraphNodeFact;
  targetNodes: readonly StorageVnextGraphNodeFact[];
  relationships: readonly SemanticFileRelationshipCandidate[];
  maximumEdges: number;
}): StorageVnextGraphEdgeFact[] {
  validateInput(input);
  const nodesBySource = new Map(input.targetNodes.map((node) =>
    [node.sourceFilePublicId, node]));
  const grouped = new Map<string, {
    target: StorageVnextGraphNodeFact;
    relationships: SemanticFileRelationshipCandidate[];
    evidence: Map<string, StorageVnextGraphEvidence>;
  }>();
  for (const candidate of input.relationships) {
    const target = nodesBySource.get(candidate.targetSourceFilePublicId);
    if (!isSupportedCandidate(input, candidate, target)) continue;
    const key = target!.publicId;
    const group: {
      target: StorageVnextGraphNodeFact;
      relationships: SemanticFileRelationshipCandidate[];
      evidence: Map<string, StorageVnextGraphEvidence>;
    } = grouped.get(key) ?? {
      target: target!,
      relationships: [],
      evidence: new Map()
    };
    if (group.relationships.length < MAX_PRESENTED_RELATIONSHIPS_PER_EDGE) {
      const signature = relationshipSignature(candidate);
      if (!group.relationships.some((value) =>
        relationshipSignature(value) === signature)) {
        group.relationships.push(candidate);
      }
    }
    for (const evidence of candidate.evidence) {
      if (group.evidence.size >= MAX_STORAGE_VNEXT_GRAPH_EVIDENCE_REFS) break;
      const mapped = mapEvidence(input, target!, evidence);
      if (mapped) group.evidence.set(evidenceSignature(mapped), mapped);
    }
    if (group.evidence.size > 0) grouped.set(key, group);
  }
  return [...grouped.values()]
    .sort((left, right) => compareUtf8(left.target.publicId, right.target.publicId))
    .slice(0, input.maximumEdges)
    .map((group) => createEdge(input, group));
}

function createEdge(
  input: Parameters<typeof planSemanticFileGraphEdges>[0],
  group: {
    target: StorageVnextGraphNodeFact;
    relationships: SemanticFileRelationshipCandidate[];
    evidence: Map<string, StorageVnextGraphEvidence>;
  }
): StorageVnextGraphEdgeFact {
  const relationships = [...group.relationships].sort(compareRelationships);
  const strongest = relationships.reduce((winner, candidate) =>
    candidate.confidence > winner.confidence ? candidate : winner);
  const publicId = stablePublicId("semantic-file-edge-v1", [
    input.knowledgeBaseId,
    input.source.publicId,
    group.target.publicId,
    "semantic_relationship"
  ]);
  const evidence = [...group.evidence.values()].sort(compareEvidence);
  return {
    publicId,
    knowledgeBaseId: input.knowledgeBaseId,
    fromNodePublicId: input.source.publicId,
    toNodePublicId: group.target.publicId,
    relation: "semantic_relationship",
    weight: strongest.confidence,
    reason: boundedText(relationshipReason(strongest), 2_048),
    source: "semantic_evidence",
    metadata: {
      signal: "semantic_relationship",
      relationships: relationships.map((relationship) => ({
        from: boundedText(relationship.fromEntityLabel, 256),
        to: boundedText(relationship.toEntityLabel, 256),
        type: boundedText(relationship.kind, 128),
        description: relationship.description
          ? boundedText(relationship.description, 512)
          : null,
        confidence: relationship.confidence
      })),
      evidencePaths: [...new Set(evidence.map((item) => item.logicalPath))]
        .slice(0, 4)
        .map((logicalPath) => boundedText(logicalPath, 512))
    },
    evidence,
    revision: input.source.revision
  };
}

function isSupportedCandidate(
  input: Parameters<typeof planSemanticFileGraphEdges>[0],
  candidate: SemanticFileRelationshipCandidate,
  target: StorageVnextGraphNodeFact | undefined
): target is StorageVnextGraphNodeFact {
  return Boolean(
    target
    && target.knowledgeBaseId === input.knowledgeBaseId
    && target.sourceFilePublicId !== input.source.sourceFilePublicId
    && target.sourceRevisionPublicId === candidate.targetSourceRevisionPublicId
    && validText(candidate.fromEntityLabel, 1_024)
    && validText(candidate.toEntityLabel, 1_024)
    && validText(candidate.kind, 128)
    && (candidate.description === null || validText(candidate.description, 8_192))
    && Number.isFinite(candidate.confidence)
    && candidate.confidence >= 0
    && candidate.confidence <= 1
    && candidate.evidence.length > 0
    && candidate.evidence.some((evidence) => mapEvidence(input, target, evidence))
  );
}

function mapEvidence(
  input: Parameters<typeof planSemanticFileGraphEdges>[0],
  target: StorageVnextGraphNodeFact,
  evidence: SemanticFileRelationshipEvidence
): StorageVnextGraphEvidence | null {
  const owner = evidence.sourceFilePublicId === input.source.sourceFilePublicId
    ? input.source
    : evidence.sourceFilePublicId === target.sourceFilePublicId ? target : null;
  if (
    !owner
    || owner.sourceRevisionPublicId !== evidence.sourceRevisionPublicId
    || evidence.logicalPath !== owner.logicalPath
    || !Number.isSafeInteger(evidence.startOffset)
    || !Number.isSafeInteger(evidence.endOffset)
    || evidence.startOffset < 0
    || evidence.endOffset < evidence.startOffset
    || !/^[0-9a-f]{64}$/u.test(evidence.excerptChecksumSha256)
  ) return null;
  const publicId = stablePublicId("semantic-file-evidence-v1", [
    input.knowledgeBaseId,
    input.source.publicId,
    target.publicId,
    evidence.sourceFilePublicId,
    evidence.sourceRevisionPublicId,
    evidence.logicalPath,
    String(evidence.startOffset),
    String(evidence.endOffset),
    evidence.excerptChecksumSha256
  ]);
  return {
    publicId,
    sourceFilePublicId: evidence.sourceFilePublicId,
    sourceRevisionPublicId: evidence.sourceRevisionPublicId,
    logicalPath: evidence.logicalPath,
    startOffset: evidence.startOffset,
    endOffset: evidence.endOffset,
    checksum: evidence.excerptChecksumSha256
  };
}

function validateInput(input: Parameters<typeof planSemanticFileGraphEdges>[0]): void {
  if (
    !validText(input.knowledgeBaseId, 255)
    || input.source.knowledgeBaseId !== input.knowledgeBaseId
    || !Number.isSafeInteger(input.maximumEdges)
    || input.maximumEdges < 1
    || input.maximumEdges > 1_000
    || input.targetNodes.length > 1_000
    || input.relationships.length > 1_000
  ) throw semanticFileGraphError("invalid_input");
}

function relationshipReason(candidate: SemanticFileRelationshipCandidate): string {
  const sentence = `${candidate.fromEntityLabel} ${candidate.kind} ${candidate.toEntityLabel}.`;
  return candidate.description ? `${sentence} ${candidate.description}` : sentence;
}

function relationshipSignature(candidate: SemanticFileRelationshipCandidate): string {
  return [
    candidate.fromEntityLabel,
    candidate.toEntityLabel,
    candidate.kind,
    candidate.description ?? "",
    String(candidate.confidence)
  ].join("\u001f");
}

function evidenceSignature(evidence: StorageVnextGraphEvidence): string {
  return [
    evidence.sourceFilePublicId,
    evidence.sourceRevisionPublicId,
    evidence.logicalPath,
    String(evidence.startOffset),
    String(evidence.endOffset),
    evidence.checksum
  ].join("\u001f");
}

function compareRelationships(
  left: SemanticFileRelationshipCandidate,
  right: SemanticFileRelationshipCandidate
): number {
  return compareUtf8(relationshipSignature(left), relationshipSignature(right));
}

function compareEvidence(
  left: StorageVnextGraphEvidence,
  right: StorageVnextGraphEvidence
): number {
  return compareUtf8(evidenceSignature(left), evidenceSignature(right));
}

function stablePublicId(namespace: string, parts: readonly string[]): string {
  return `${namespace}-${createHash("sha256")
    .update(parts.join("\u001f"), "utf8")
    .digest("hex")}`;
}

function boundedText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > maximumBytes) break;
    output += character;
  }
  return output;
}

function validText(value: string, maximumBytes: number): boolean {
  return Boolean(value.trim()) && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function semanticFileGraphError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Semantic file graph error: ${code}`), { code });
}
