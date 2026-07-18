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

  const discovered: ActiveGenerationProjection[] = [];
  let firstCursor: ActiveGenerationScoredCursor | null = null;
  for (const [index, sourceFileId] of input.seedSourceFileIds.entries()) {
    const page = await scope.listRelated({
      sourceFileId,
      limit: index === 0 ? input.limit : input.fanout,
      cursor: index === 0 ? input.cursor : null
    });
    if (index === 0) firstCursor = page.nextCursor;
    discovered.push(...page.items);
  }

  const firstHop = uniqueRelationships(discovered, input.excludedSourceFileIds);
  if (input.depth < 2) {
    return { items: firstHop.slice(0, input.limit), nextCursor: firstCursor };
  }

  const secondHop: ActiveGenerationProjection[] = [];
  for (const relationship of firstHop.slice(0, input.fanout)) {
    if (!relationship.relatedSourceFileId) continue;
    const page = await scope.listRelated({
      sourceFileId: relationship.relatedSourceFileId,
      limit: input.fanout,
      cursor: null
    });
    secondHop.push(...page.items);
  }

  return {
    items: uniqueRelationships([...firstHop, ...secondHop], input.excludedSourceFileIds)
      .slice(0, input.limit),
    nextCursor: firstCursor
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
  return output;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}
