import type { OkfGraphEdgeSource, OkfGraphRelationship } from "./graph.js";

const MAX_EVIDENCE_KEYS = 16;
const MAX_EVIDENCE_ITEMS = 16;
const MAX_EVIDENCE_STRING_LENGTH = 500;
const MAX_EVIDENCE_DEPTH = 3;
const MAX_ENDPOINT_TITLE_LENGTH = 200;
const DEICTIC_REASON_PATTERN = /\b(?:current file|target file|this (?:document|file|page)|related file)\b/iu;

export type GraphRelationshipEndpoint = {
  fileId: string;
  path: string;
  title: string;
};

export type PresentableGraphEdge = {
  from: GraphRelationshipEndpoint;
  to: GraphRelationshipEndpoint;
  relationType: string;
  weight: number;
  reason: string;
  source: OkfGraphEdgeSource;
  evidence?: Record<string, unknown>;
};

export function presentGraphRelationship(
  edge: PresentableGraphEdge,
  currentFileId: string
): OkfGraphRelationship {
  if (edge.from.fileId === currentFileId) {
    return buildRelationship(edge, edge.to, "outgoing");
  }

  if (edge.to.fileId === currentFileId) {
    return buildRelationship(edge, edge.from, "incoming");
  }

  throw new Error("Current file must be a graph edge endpoint.");
}

function buildRelationship(
  edge: PresentableGraphEdge,
  related: GraphRelationshipEndpoint,
  direction: OkfGraphRelationship["direction"]
): OkfGraphRelationship {
  const reason = formatDirectionAwareReason(edge, direction);

  return {
    fileId: related.fileId,
    path: related.path,
    title: related.title,
    relationType: edge.relationType,
    direction,
    weight: edge.weight,
    reason,
    source: edge.source,
    ...(edge.evidence ? { evidence: boundGraphEvidence(edge.evidence) } : {})
  };
}

function formatDirectionAwareReason(
  edge: PresentableGraphEdge,
  direction: OkfGraphRelationship["direction"]
): string {
  const fromTitle = normalizeEndpointTitle(edge.from.title);
  const toTitle = normalizeEndpointTitle(edge.to.title);
  const fact = edge.reason.trim();
  const fallback = fact || "The connected Markdown content contains accepted relationship evidence.";
  const prefix = direction === "incoming" ? "Incoming from" : "From";

  return `${prefix} "${fromTitle}" to "${toTitle}": ${fallback}`.slice(0, 1_000);
}

export function normalizeDurableGraphReason(input: {
  reason: string;
  fallbackReason: string;
}): string {
  const candidate = input.reason.trim();
  const fallback = input.fallbackReason.trim();
  const fact = candidate && !DEICTIC_REASON_PATTERN.test(candidate) ? candidate : fallback;
  const normalizedFact = fact && !DEICTIC_REASON_PATTERN.test(fact)
    ? fact
    : "The connected Markdown content contains accepted relationship evidence.";
  return normalizedFact.slice(0, 1_000);
}

export function boundGraphEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(evidence)
      .slice(0, MAX_EVIDENCE_KEYS)
      .map(([key, value]) => [key.slice(0, 100), boundEvidenceValue(value, 0)])
  );
}

function boundEvidenceValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.slice(0, MAX_EVIDENCE_STRING_LENGTH);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean" || value === null) {
    return value;
  }
  if (depth >= MAX_EVIDENCE_DEPTH) {
    return null;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_EVIDENCE_ITEMS)
      .map((item) => boundEvidenceValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_EVIDENCE_KEYS)
        .map(([key, item]) => [key.slice(0, 100), boundEvidenceValue(item, depth + 1)])
    );
  }
  return null;
}

function normalizeEndpointTitle(value: string): string {
  const title = value.trim().replaceAll('"', "'").slice(0, MAX_ENDPOINT_TITLE_LENGTH);
  return title || "Untitled Markdown file";
}
