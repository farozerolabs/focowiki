export type OkfGraphNode = {
  fileId: string;
  path: string;
  title: string;
  type?: string | null;
  description?: string | null;
  summary?: string | null;
  subjects?: string[];
  tags?: string[];
  entities?: string[];
  explicitReferences?: string[];
  relationshipHints?: string[];
  headings?: string[];
  keywords?: string[];
  language?: string | null;
  profileVersion?: string | null;
  profileSource?: string | null;
  metadata?: Record<string, unknown>;
};

export type OkfGraphEdgeSource = "deterministic" | "model_confirmed" | string;

export type OkfGraphEdge = {
  fromFileId: string;
  toFileId: string;
  relationType: string;
  weight: number;
  reason: string;
  source: OkfGraphEdgeSource;
  evidence?: Record<string, unknown>;
};

export const SYMMETRIC_GRAPH_RELATION_TYPES = [
  "background",
  "collection_neighbor",
  "process_adjacent",
  "same_entity",
  "same_specific_subject",
  "version_relation"
] as const;

export type OkfGraphLimits = {
  pageRelatedLimit?: number;
  perFileLimit?: number;
  edgeShardSize?: number;
};

export type OkfGraphRelationship = {
  fileId: string;
  path: string;
  title: string;
  relationType: string;
  direction: "outgoing" | "incoming";
  weight: number;
  reason: string;
  source: OkfGraphEdgeSource;
  evidence?: Record<string, unknown>;
};

const LOW_INFORMATION_SHARED_TERMS = new Set([
  "mergeformat",
  "document",
  "section",
  "reference",
  "related",
  "source",
  "current",
  "文档",
  "文件",
  "资料",
  "内容",
  "信息",
  "章节",
  "引用",
  "参考",
  "相关",
  "当前"
]);

export function graphRefForFile(fileId: string): string {
  return `_graph/by-file/${encodeGraphFileId(fileId)}.json`;
}

export function deduplicateGraphRelationships(
  relationships: OkfGraphRelationship[]
): OkfGraphRelationship[] {
  return uniqueBy(
    [...relationships].sort(compareRelationships),
    (relationship) => relationship.fileId || relationship.path
  );
}

function compareRelationships(left: OkfGraphRelationship, right: OkfGraphRelationship): number {
  const leftDirectionScore = left.direction === "outgoing" ? 0 : 1;
  const rightDirectionScore = right.direction === "outgoing" ? 0 : 1;

  return (
    right.weight - left.weight ||
    leftDirectionScore - rightDirectionScore ||
    left.title.localeCompare(right.title) ||
    left.fileId.localeCompare(right.fileId)
  );
}

export function isLowInformationSharedGraphTerm(value: string): boolean {
  const normalized = normalizeComparableText(value);

  if (!normalized || LOW_INFORMATION_SHARED_TERMS.has(normalized)) {
    return true;
  }

  if (/^\d+$/u.test(normalized)) {
    return true;
  }

  if (/^(?:第|项|条|章|节|页|段|部分|篇|卷|版|次|年月日号)+$/u.test(normalized)) {
    return true;
  }

  return false;
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/gu, "");
}

function encodeGraphFileId(fileId: string): string {
  return fileId.split("/").map(encodeURIComponent).join("/");
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const item of items) {
    const itemKey = key(item);

    if (seen.has(itemKey)) {
      continue;
    }

    seen.add(itemKey);
    unique.push(item);
  }

  return unique;
}
