import type {
  ActiveGenerationFile,
  ActiveGenerationPage,
  ActiveGenerationProjection,
  ActiveGenerationReadScope,
  ActiveGenerationScoredCursor
} from "../application/ports/active-generation-read-repository.js";
import type { GraphSearchDepth } from "../search/graph-search-documents.js";

export type ActiveGenerationGraphExpansionInput = {
  fileId: string | null;
  nodeId: string | null;
  edgeId: string | null;
  query: string | null;
  depth: GraphSearchDepth;
  fanout: number;
  limit: number;
  cursor: ActiveGenerationScoredCursor | null;
};

export type ActiveGenerationGraphExpansion = {
  seedFile: ActiveGenerationFile | null;
  seedResults: ActiveGenerationProjection[];
  relationships: ActiveGenerationProjection[];
  seedCount: number;
  nextCursor: ActiveGenerationScoredCursor | null;
};

export async function expandActiveGenerationGraph(
  scope: ActiveGenerationReadScope,
  input: ActiveGenerationGraphExpansionInput
): Promise<ActiveGenerationGraphExpansion | null> {
  if (input.fileId || input.nodeId) {
    const file = await scope.findFileById(input.fileId ?? input.nodeId!);
    if (!file?.sourceFileId) return null;
    const page = await expandRelationships(scope, {
      seedSourceFileIds: [file.sourceFileId],
      excludedSourceFileIds: new Set([file.sourceFileId]),
      depth: input.depth,
      fanout: input.fanout,
      limit: input.limit,
      cursor: input.cursor
    });
    return {
      seedFile: file,
      seedResults: [],
      relationships: page.items,
      seedCount: 1,
      nextCursor: page.nextCursor
    };
  }

  if (input.edgeId) {
    const edge = await scope.findProjection({
      projectionKind: "graph_edge",
      recordId: input.edgeId
    });
    if (!edge?.sourceFileId || !edge.relatedSourceFileId) return null;
    const file = await scope.findFileById(edge.sourceFileId);
    if (!file) return null;
    const page = await expandRelationships(scope, {
      seedSourceFileIds: [edge.sourceFileId],
      excludedSourceFileIds: new Set([edge.sourceFileId]),
      depth: input.depth,
      fanout: input.fanout,
      limit: input.limit,
      cursor: input.cursor
    });
    return {
      seedFile: file,
      seedResults: [],
      relationships: page.items,
      seedCount: 2,
      nextCursor: page.nextCursor
    };
  }

  if (input.query) {
    const seeds = await scope.search({
      query: input.query,
      mode: "graph",
      limit: input.limit,
      cursor: input.cursor
    });
    const sourceFileIds = uniqueStrings(
      seeds.items.map((item) => item.sourceFileId).filter(isString)
    );
    const page = await expandRelationships(scope, {
      seedSourceFileIds: sourceFileIds.slice(0, input.fanout),
      excludedSourceFileIds: new Set(sourceFileIds),
      depth: input.depth,
      fanout: input.fanout,
      limit: input.limit,
      cursor: null
    });
    return {
      seedFile: null,
      seedResults: seeds.items,
      relationships: page.items,
      seedCount: seeds.items.length,
      nextCursor: seeds.nextCursor
    };
  }

  return null;
}

async function expandRelationships(
  scope: ActiveGenerationReadScope,
  input: {
    seedSourceFileIds: string[];
    excludedSourceFileIds: ReadonlySet<string>;
    depth: GraphSearchDepth;
    fanout: number;
    limit: number;
    cursor: ActiveGenerationScoredCursor | null;
  }
): Promise<ActiveGenerationPage<ActiveGenerationProjection, ActiveGenerationScoredCursor>> {
  if (input.depth === 0 || input.seedSourceFileIds.length === 0) {
    return { items: [], nextCursor: null };
  }

  const firstPage = await scope.listRelatedForSources({
    sourceFileIds: input.seedSourceFileIds,
    limitPerSource: input.fanout
  });
  const firstHop = uniqueRelationships(
    input.seedSourceFileIds.flatMap((sourceFileId) => firstPage.get(sourceFileId) ?? []),
    input.excludedSourceFileIds
  );
  if (input.depth < 2) {
    return paginateRelationships(firstHop, input.cursor, input.limit);
  }

  const secondSeeds = uniqueStrings(
    firstHop.slice(0, input.fanout)
      .map((relationship) => relationship.relatedSourceFileId)
      .filter(isString)
  );
  const secondPage = await scope.listRelatedForSources({
    sourceFileIds: secondSeeds,
    limitPerSource: input.fanout
  });
  const secondHop = secondSeeds.flatMap((sourceFileId) => secondPage.get(sourceFileId) ?? []);

  return paginateRelationships(
    uniqueRelationships([...firstHop, ...secondHop], input.excludedSourceFileIds),
    input.cursor,
    input.limit
  );
}

function paginateRelationships(
  relationships: ActiveGenerationProjection[],
  cursor: ActiveGenerationScoredCursor | null,
  limit: number
): ActiveGenerationPage<ActiveGenerationProjection, ActiveGenerationScoredCursor> {
  const afterCursor = cursor ? relationships.filter((relationship) => {
    const score = relationship.score ?? 0;
    return score < cursor.score
      || (score === cursor.score && relationship.recordId > cursor.recordId);
  }) : relationships;
  const items = afterCursor.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: afterCursor.length > limit && last
      ? { score: last.score ?? 0, recordId: last.recordId }
      : null
  };
}

function uniqueRelationships(
  relationships: ActiveGenerationProjection[],
  excludedSourceFileIds: ReadonlySet<string>
): ActiveGenerationProjection[] {
  const seen = new Set<string>();
  const output: ActiveGenerationProjection[] = [];
  for (const relationship of relationships) {
    const targetId = relationship.relatedSourceFileId;
    if (!targetId || excludedSourceFileIds.has(targetId) || seen.has(targetId)) continue;
    seen.add(targetId);
    output.push(relationship);
  }
  return output.sort((left, right) =>
    (right.score ?? 0) - (left.score ?? 0)
    || left.recordId.localeCompare(right.recordId, "en")
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}
