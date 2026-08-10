import { createHash } from "node:crypto";
import type { SemanticSourceChunk } from "./source-chunks.js";

export const SEMANTIC_SKELETON_POLICY_VERSION = "semantic-skeleton-policy-v2";

export type SemanticSkeletonSelectionReason =
  | "stable_sample"
  | "structural_bridge"
  | "definition_density"
  | "file_graph_bridge"
  | "neighbor_novelty";

export type SemanticSkeletonGraphSignals = {
  acceptedEdgeCount: number;
  inboundEdgeCount: number;
  outboundEdgeCount: number;
  distinctNeighborCount: number;
  relationKindCount: number;
  contentProfileHeadingCount?: number;
  contentProfileDefinitionCount?: number;
  contentProfileExplicitReferenceCount?: number;
};

export type SemanticSkeletonSelection = {
  policyVersion: string;
  selected: boolean;
  selectedChunkIds: readonly string[];
  reasons: readonly SemanticSkeletonSelectionReason[];
  decisionSha256: string;
  sourceChunkCount: number;
};

export type SemanticSkeletonPolicy = {
  stableSamplingBasisPoints: number;
  structuralSelectionThreshold: number;
  maximumSelectedChunks: number;
};

export const DEFAULT_SEMANTIC_SKELETON_POLICY: Readonly<SemanticSkeletonPolicy> =
  Object.freeze({
    stableSamplingBasisPoints: 500,
    structuralSelectionThreshold: 16,
    maximumSelectedChunks: 2
  });

export function selectSemanticSkeleton(input: {
  sourceRevisionPublicId: string;
  logicalPath: string;
  markdown: string;
  chunks: readonly SemanticSourceChunk[];
  graphSignals?: SemanticSkeletonGraphSignals;
  policy?: SemanticSkeletonPolicy;
}): SemanticSkeletonSelection {
  const policy = input.policy ?? DEFAULT_SEMANTIC_SKELETON_POLICY;
  const graphSignals = normalizeGraphSignals(input.graphSignals ?? emptyGraphSignals());
  assertPolicy(policy);
  assertGraphSignals(graphSignals);
  if (!input.sourceRevisionPublicId || !input.logicalPath || input.chunks.length === 0) {
    throw new Error("Semantic skeleton selection input is invalid");
  }

  const contentIdentity = sha256(input.chunks.map((chunk) => chunk.text).join("\u001e"));
  const stableBucket = Number.parseInt(contentIdentity.slice(0, 8), 16) % 10_000;
  const stableSample = stableBucket < policy.stableSamplingBasisPoints;
  const chunkScores = input.chunks.map((chunk, index) => scoreChunk(chunk.text, index));
  const structuralScore = chunkScores.reduce((total, item) => total + item.bridgeScore, 0)
    + graphSignals.contentProfileExplicitReferenceCount * 4;
  const definitionScore = chunkScores.reduce((total, item) => total + item.definitionScore, 0)
    + graphSignals.contentProfileDefinitionCount * 4;
  const reasons: SemanticSkeletonSelectionReason[] = [];
  if (stableSample) reasons.push("stable_sample");
  if (stableSample && structuralScore >= policy.structuralSelectionThreshold) {
    reasons.push("structural_bridge");
  }
  if (stableSample && definitionScore >= policy.structuralSelectionThreshold) {
    reasons.push("definition_density");
  }
  if (stableSample && graphSignals.acceptedEdgeCount >= 4
    && graphSignals.distinctNeighborCount >= 4) {
    reasons.push("file_graph_bridge");
  }
  if (stableSample && graphSignals.distinctNeighborCount >= 4
    && graphSignals.relationKindCount >= 2) {
    reasons.push("neighbor_novelty");
  }
  const selected = stableSample;
  const selectedChunkIds = selected
    ? chunkScores
      .slice()
      .sort((left, right) => right.total - left.total || left.index - right.index)
      .slice(0, policy.maximumSelectedChunks)
      .map(({ index }) => input.chunks[index]!.id)
    : [];
  const decisionSha256 = sha256(JSON.stringify({
    policyVersion: SEMANTIC_SKELETON_POLICY_VERSION,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    contentIdentity,
    stableBucket,
    structuralScore,
    definitionScore,
    graphSignals,
    reasons,
    selectedChunkIds
  }));

  return {
    policyVersion: SEMANTIC_SKELETON_POLICY_VERSION,
    selected,
    selectedChunkIds,
    reasons,
    decisionSha256,
    sourceChunkCount: input.chunks.length
  };
}

function emptyGraphSignals(): SemanticSkeletonGraphSignals {
  return {
    acceptedEdgeCount: 0,
    inboundEdgeCount: 0,
    outboundEdgeCount: 0,
    distinctNeighborCount: 0,
    relationKindCount: 0,
    contentProfileHeadingCount: 0,
    contentProfileDefinitionCount: 0,
    contentProfileExplicitReferenceCount: 0
  };
}

function normalizeGraphSignals(
  signals: SemanticSkeletonGraphSignals
): Required<SemanticSkeletonGraphSignals> {
  return {
    ...signals,
    contentProfileHeadingCount: signals.contentProfileHeadingCount ?? 0,
    contentProfileDefinitionCount: signals.contentProfileDefinitionCount ?? 0,
    contentProfileExplicitReferenceCount:
      signals.contentProfileExplicitReferenceCount ?? 0
  };
}

function assertGraphSignals(signals: SemanticSkeletonGraphSignals): void {
  const counts = Object.values(signals);
  if (counts.some((value) => !Number.isSafeInteger(value)
    || value < 0 || value > 64)
    || signals.inboundEdgeCount + signals.outboundEdgeCount
      < signals.acceptedEdgeCount) {
    throw new Error("Semantic skeleton graph signals are invalid");
  }
}

function scoreChunk(text: string, index: number) {
  const content = index === 0 ? stripLeadingFrontmatter(text) : text;
  const markdownReferences = [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .filter((match) => isLocalReference(match[1] ?? "")).length;
  const urlReferences = content.match(/https?:\/\/[^\s)>]+/gu)?.length ?? 0;
  const headings = content.match(/^#{1,6}\s+.+$/gmu)?.length ?? 0;
  const definitions = content.match(
    /\b(?:is|are)\s+(?:defined|described)\s+as\b|\bmeans\b|\brefers\s+to\b|定义为|是指|指的是|意味着/giu
  )?.length ?? 0;
  const bridgeScore = markdownReferences * 4;
  const definitionScore = definitions * 4;
  return {
    index,
    bridgeScore,
    definitionScore,
    total: bridgeScore + definitionScore + Math.min(2, headings)
      + Math.min(1, urlReferences) + (index === 0 ? 1 : 0)
  };
}

function stripLeadingFrontmatter(value: string): string {
  if (!value.startsWith("---\n") && !value.startsWith("---\r\n")) return value;
  const match = value.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u);
  return match ? value.slice(match[0].length) : value;
}

function isLocalReference(value: string): boolean {
  const target = value.trim().split(/\s+/u, 1)[0]?.replace(/^<|>$/gu, "") ?? "";
  return target.length > 0
    && !/^(?:https?:|mailto:|data:|#)/iu.test(target);
}

function assertPolicy(policy: SemanticSkeletonPolicy): void {
  if (!Number.isSafeInteger(policy.stableSamplingBasisPoints)
    || policy.stableSamplingBasisPoints < 0
    || policy.stableSamplingBasisPoints > 10_000
    || !Number.isSafeInteger(policy.structuralSelectionThreshold)
    || policy.structuralSelectionThreshold < 1
    || policy.structuralSelectionThreshold > 1_000
    || !Number.isSafeInteger(policy.maximumSelectedChunks)
    || policy.maximumSelectedChunks < 1
    || policy.maximumSelectedChunks > 8) {
    throw new Error("Semantic skeleton policy is invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
