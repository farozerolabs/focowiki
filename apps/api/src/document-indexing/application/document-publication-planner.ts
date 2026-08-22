import { posix } from "node:path";

export type DocumentPublicationFactDelta = Readonly<{
  mutationPublicId: string;
  documentJobPublicId: string | null;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  factEpoch: number;
  operation: "create" | "replace" | "move" | "delete" | "repair";
  priorLogicalPath: string | null;
  nextLogicalPath: string | null;
  priorTermBuckets: readonly string[];
  nextTermBuckets: readonly string[];
  relatedSourceFilePublicIds: readonly string[];
  priorGraphDirectoryPaths: readonly string[];
  nextGraphDirectoryPaths: readonly string[];
}>;

export type DocumentPublicationScopeNode = Readonly<{
  identity: string;
  kind: "source" | "relation" | "directory" | "graph"
    | "_index" | "_graph" | "root" | "validation";
  key: string;
  dependsOn: readonly string[];
}>;

export function planDocumentPublicationGeneration(input: Readonly<{
  generationPublicId: string;
  baseGenerationPublicId: string | null;
  targetFactEpoch: number;
  rendererContractVersion: string;
  deterministicChangedAt: string;
  documents: readonly DocumentPublicationFactDelta[];
}>) {
  if (!input.generationPublicId || input.documents.length < 1
    || input.documents.length > 256) {
    throw new Error("DOCUMENT_PUBLICATION_PLAN_INVALID");
  }
  const nodes = new Map<string, MutableNode>();
  const puts = new Set<string>();
  const deletes = new Set<string>();
  const tombstones = new Set<string>();
  const searchSourceFilePublicIds = new Set<string>();
  let graphChanged = false;
  let termChanged = false;

  for (const document of input.documents) {
    validateDelta(document);
    const sourceIdentity = `source:${document.sourceFilePublicId}`;
    addNode(nodes, sourceIdentity, "source", document.sourceFilePublicId);
    if (document.nextLogicalPath) {
      puts.add(pagePath(document.nextLogicalPath));
    }
    if (document.priorLogicalPath
      && document.priorLogicalPath !== document.nextLogicalPath) {
      deletes.add(pagePath(document.priorLogicalPath));
      tombstones.add(document.sourceFilePublicId);
    }
    searchSourceFilePublicIds.add(document.sourceFilePublicId);
    const directoryPaths = new Set([
      ...pageAncestors(document.priorLogicalPath),
      ...pageAncestors(document.nextLogicalPath)
    ]);
    for (const directoryPath of directoryPaths) {
      const directory = `directory:${directoryPath}`;
      addNode(nodes, directory, "directory", directoryPath, [sourceIdentity]);
      addNode(
        nodes,
        `_index:pages:${directoryPath}`,
        "_index",
        `pages:${directoryPath}`,
        [sourceIdentity]
      );
    }
    const termBuckets = new Set([
      ...document.priorTermBuckets,
      ...document.nextTermBuckets
    ]);
    for (const bucket of termBuckets) {
      addNode(nodes, `_index:term:${bucket}`, "_index", `term:${bucket}`);
      termChanged = true;
    }
    const graphSources = new Set([
      document.sourceFilePublicId,
      ...document.relatedSourceFilePublicIds
    ]);
    if (document.relatedSourceFilePublicIds.length > 0
      || document.priorGraphDirectoryPaths.length > 0
      || document.nextGraphDirectoryPaths.length > 0) {
      graphChanged = true;
      for (const sourceFilePublicId of graphSources) {
        addNode(nodes, `source:${sourceFilePublicId}`, "source",
          sourceFilePublicId);
        addNode(nodes, `_graph:${sourceFilePublicId}`, "_graph",
          sourceFilePublicId);
        searchSourceFilePublicIds.add(sourceFilePublicId);
      }
      for (const graphDirectory of new Set([
        ...document.priorGraphDirectoryPaths,
        ...document.nextGraphDirectoryPaths
      ])) {
        const graphDependencies = [...graphSources]
          .map((source) => `_graph:${source}`);
        addNode(nodes, `_graph:directory:${graphDirectory}`, "_graph",
          `directory:${graphDirectory}`, graphDependencies);
        addNode(nodes, `_graph:file-directory:${graphDirectory}`, "_graph",
          `file-directory:${graphDirectory}`, graphDependencies);
      }
    }
  }

  if (termChanged) {
    addNode(nodes, "_index:term-catalog", "_index", "term-catalog",
      [...nodes.keys()].filter((key) => key.startsWith("_index:term:")));
  }
  if (graphChanged) {
    addNode(nodes, "_graph:catalog", "_graph", "catalog",
      [...nodes.keys()].filter((key) => key.startsWith("_graph:")
        && key !== "_graph:catalog"));
  }
  const structural = [...nodes.keys()];
  addNode(nodes, "root:index", "root", "index", structural);
  addNode(nodes, `validation:${input.generationPublicId}`, "validation",
    input.generationPublicId, [...nodes.keys()]);
  const scopes = [...nodes.values()].map((node) => ({
    ...node,
    dependsOn: [...node.dependsOn].sort(bytewise)
  })).sort((left, right) => layer(left.kind) - layer(right.kind)
    || bytewise(left.identity, right.identity));
  return {
    generationPublicId: input.generationPublicId,
    baseGenerationPublicId: input.baseGenerationPublicId,
    targetFactEpoch: input.targetFactEpoch,
    rendererContractVersion: input.rendererContractVersion,
    deterministicChangedAt: input.deterministicChangedAt,
    mutationPublicIds: input.documents.map((item) => item.mutationPublicId)
      .sort(bytewise),
    scopes,
    putPaths: [...puts].sort(bytewise),
    deletePaths: [...deletes].sort(bytewise),
    tombstoneSourceFilePublicIds: [...tombstones].sort(bytewise),
    searchSourceFilePublicIds: [...searchSourceFilePublicIds].sort(bytewise)
  };
}

type MutableNode = {
  identity: string;
  kind: DocumentPublicationScopeNode["kind"];
  key: string;
  dependsOn: Set<string>;
};

function addNode(
  nodes: Map<string, MutableNode>,
  identity: string,
  kind: MutableNode["kind"],
  key: string,
  dependencies: readonly string[] = []
): void {
  const node = nodes.get(identity) ?? {
    identity,
    kind,
    key,
    dependsOn: new Set<string>()
  };
  dependencies.filter((dependency) => dependency !== identity)
    .forEach((dependency) => node.dependsOn.add(dependency));
  nodes.set(identity, node);
}

function pageAncestors(logicalPath: string | null): readonly string[] {
  if (!logicalPath) return [];
  const ancestors: string[] = [];
  let current = posix.dirname(pagePath(logicalPath));
  while (current === "pages" || current.startsWith("pages/")) {
    ancestors.push(current);
    if (current === "pages") break;
    current = posix.dirname(current);
  }
  return ancestors;
}

function pagePath(logicalPath: string): string {
  const path = logicalPath.startsWith("pages/")
    ? logicalPath : `pages/${logicalPath}`;
  if (path.startsWith("/") || path.includes("..") || !path.endsWith(".md")) {
    throw new Error("DOCUMENT_PUBLICATION_PATH_INVALID");
  }
  return path;
}

function validateDelta(delta: DocumentPublicationFactDelta): void {
  if (!delta.mutationPublicId || !delta.sourceFilePublicId
    || !delta.sourceRevisionPublicId || !Number.isSafeInteger(delta.factEpoch)
    || delta.factEpoch < 1
    || (delta.nextLogicalPath === null && delta.priorLogicalPath === null)) {
    throw new Error("DOCUMENT_PUBLICATION_DELTA_INVALID");
  }
}

function layer(kind: MutableNode["kind"]): number {
  if (["source", "relation", "graph"].includes(kind)) return 0;
  if (["directory", "_index", "_graph"].includes(kind)) return 1;
  if (kind === "root") return 3;
  return 4;
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
