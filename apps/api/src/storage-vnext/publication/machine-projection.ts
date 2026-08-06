import {
  deduplicateGraphRelationships,
  presentGraphRelationship,
  resolveSourceMetadata,
  type SourceMetadataDefaults,
  type SourceMetadataSuggestions
} from "@focowiki/okf";
import { resolveProjectionShard } from "../../domain/generation.js";
import { applyPresentationSuggestions } from "../../okf/publication-files.js";
import {
  renderShard,
  type JsonProjectionRecord
} from "../../publication/projection-shard-partitioning.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact
} from "../graph/ports.js";
import type {
  StorageVnextPublicDocument,
  StorageVnextPublicValue
} from "../shared/types.js";
import type {
  StorageVnextPublicationDirectoryInput,
  StorageVnextPublicationPageInput
} from "./artifact-assembler.js";
import type { StorageVnextPublicationBatchPlan } from "./planning.js";
import type { StorageVnextPublicationArtifact } from "./types.js";

export type StorageVnextMachineProjectionKind = "search" | "manifest" | "tree" | "graph_node"
  | "links" | "graph_edge" | "related_files";

type ProjectionChange = {
  projectionKind: StorageVnextMachineProjectionKind;
  shardKey: string;
  logicalPath: string;
  records: Map<string, JsonProjectionRecord | null>;
};

export type StorageVnextMachineProjectionShard = {
  projectionKind: string;
  shardKey: string;
  logicalPath: string;
  recordCount: number;
};

export async function assembleStorageVnextMachineProjection(input: {
  knowledgeBaseId: string;
  candidatePublicId: string;
  plan: StorageVnextPublicationBatchPlan;
  affectedSourceFilePublicIds: readonly string[];
  pages: readonly StorageVnextPublicationPageInput[];
  directories: readonly StorageVnextPublicationDirectoryInput[];
  getEdge(publicId: string): Promise<StorageVnextGraphEdgeFact | null>;
  getNode(publicId: string): Promise<StorageVnextGraphNodeFact | null>;
  readExisting(logicalPath: string): Promise<readonly JsonProjectionRecord[]>;
  shardCounts: {
    search: number;
    links: number;
    manifest: number;
    tree: number;
    graphNode: number;
    graphEdge: number;
  };
  maximumArtifactBytes: number;
  relatedFileLimit: number;
  signal: AbortSignal;
  includedProjectionKinds?: readonly StorageVnextMachineProjectionKind[];
}): Promise<{
  artifacts: StorageVnextPublicationArtifact[];
  deletedLogicalPaths: string[];
  shards: StorageVnextMachineProjectionShard[];
}> {
  const includedProjectionKinds = new Set(
    input.includedProjectionKinds ?? [
      "search",
      "manifest",
      "tree",
      "graph_node",
      "links",
      "graph_edge",
      "related_files"
    ]
  );
  const changes = new Map<string, ProjectionChange>();
  const pageBySource = new Map(input.pages.map((page) =>
    [page.current.sourceFile.publicId, page]));
  for (const sourceFilePublicId of input.affectedSourceFilePublicIds) {
    throwIfAborted(input.signal);
    const page = pageBySource.get(sourceFilePublicId) ?? null;
    for (const projectionKind of [
      "search", "manifest", "tree", "graph_node"
    ] as const) {
      if (!includedProjectionKinds.has(projectionKind)) continue;
      addChange(changes, {
        projectionKind,
        stableIdentity: sourceFilePublicId,
        recordId: sourceFilePublicId,
        record: page ? sourceRecord(projectionKind, page) : null,
        shardCount: shardCount(input.shardCounts, projectionKind)
      });
    }
  }
  for (const directoryPath of includedProjectionKinds.has("tree")
    ? input.plan.directoryPaths
    : []) {
    const relativePath = directoryPath === "pages"
      ? ""
      : directoryPath.slice("pages/".length);
    const recordId = `directory:${relativePath}`;
    const directory = input.directories.find((item) =>
      item.directoryPath === directoryPath) ?? null;
    addChange(changes, {
      projectionKind: "tree",
      stableIdentity: recordId,
      recordId,
      record: directory ? directoryRecord(directory) : null,
      shardCount: input.shardCounts.tree
    });
  }
  const edgeProjectionKinds = (["links", "graph_edge"] as const).filter((kind) =>
    includedProjectionKinds.has(kind));
  for (const edgePublicId of edgeProjectionKinds.length > 0
    ? input.plan.linkPublicIds
    : []) {
    throwIfAborted(input.signal);
    const edge = await input.getEdge(edgePublicId);
    const endpoints = edge ? await loadEndpoints(input, edge) : null;
    for (const projectionKind of edgeProjectionKinds) {
      addChange(changes, {
        projectionKind,
        stableIdentity: edgePublicId,
        recordId: edgePublicId,
        record: edge && endpoints
          ? edgeRecord(projectionKind, edge, endpoints.from, endpoints.to)
          : null,
        shardCount: shardCount(input.shardCounts, projectionKind)
      });
    }
  }

  const artifacts: StorageVnextPublicationArtifact[] = [];
  const deletedLogicalPaths: string[] = [];
  const shards: StorageVnextMachineProjectionShard[] = [];
  for (const sourceFilePublicId of includedProjectionKinds.has("related_files")
    ? input.affectedSourceFilePublicIds
    : []) {
    const logicalPath = `_graph/by-file/${encodeURIComponent(sourceFilePublicId)}.json`;
    const page = pageBySource.get(sourceFilePublicId);
    if (!page) {
      deletedLogicalPaths.push(logicalPath);
      continue;
    }
    const record = sourceRecord("related_files", page, input.relatedFileLimit);
    const bytes = encodeArtifact("related_files", sourceFilePublicId, [record]);
    assertArtifactBytes(bytes, input.maximumArtifactBytes);
    artifacts.push(artifact(logicalPath, "graph", bytes));
  }
  for (const change of [...changes.values()].sort((left, right) =>
    compareUtf8(left.logicalPath, right.logicalPath))) {
    throwIfAborted(input.signal);
    const records = new Map((await input.readExisting(change.logicalPath)).map((record) =>
      [record.id, record]));
    for (const [recordId, record] of change.records) {
      if (record) records.set(recordId, record);
      else records.delete(recordId);
    }
    if (records.size === 0) {
      deletedLogicalPaths.push(change.logicalPath);
      continue;
    }
    const ordered = [...records.values()].sort(compareRecords);
    const bytes = encodeArtifact(change.projectionKind, change.shardKey, ordered);
    assertArtifactBytes(bytes, input.maximumArtifactBytes);
    artifacts.push(artifact(
      change.logicalPath,
      change.projectionKind === "graph_node" || change.projectionKind === "graph_edge"
        ? "graph"
        : "index",
      bytes
    ));
    shards.push({
      projectionKind: change.projectionKind,
      shardKey: change.shardKey,
      logicalPath: change.logicalPath,
      recordCount: records.size
    });
  }
  return {
    artifacts: artifacts.sort((left, right) => compareUtf8(left.logicalPath, right.logicalPath)),
    deletedLogicalPaths: [...new Set(deletedLogicalPaths)].sort(compareUtf8),
    shards
  };
}

function addChange(changes: Map<string, ProjectionChange>, input: {
  projectionKind: Exclude<StorageVnextMachineProjectionKind, "related_files">;
  stableIdentity: string;
  recordId: string;
  record: JsonProjectionRecord | null;
  shardCount: number;
}): void {
  const shardKey = resolveProjectionShard({
    projectionKind: input.projectionKind,
    stableIdentity: input.stableIdentity,
    shardCount: input.shardCount
  });
  const logicalPath = input.projectionKind === "graph_node"
    || input.projectionKind === "graph_edge"
    ? `_graph/${shardKey}.json`
    : `_index/${shardKey}.json`;
  const change = changes.get(logicalPath) ?? {
    projectionKind: input.projectionKind,
    shardKey,
    logicalPath,
    records: new Map()
  };
  change.records.set(input.recordId, input.record);
  changes.set(logicalPath, change);
}

function sourceRecord(
  projectionKind: "search" | "manifest" | "tree" | "graph_node" | "related_files",
  page: StorageVnextPublicationPageInput,
  relatedFileLimit = 1_000
): JsonProjectionRecord {
  const source = page.current.sourceFile;
  const revision = page.current.sourceRevision;
  const profile = readDocument(page.node.metadata.contentProfile);
  const suggestions = readPresentationSuggestions(page.node.metadata.presentationSuggestion);
  const fileName = source.logicalPath.split("/").at(-1)!;
  const resolved = resolveSourceMetadata({
    fileName,
    content: page.sourceBody,
    metadata: source.metadata as unknown as SourceMetadataDefaults,
    suggestions
  });
  const presentationBody = readString(profile?.summary) ?? resolved.body;
  const metadata = applyPresentationSuggestions(
    resolved.metadata,
    suggestions,
    { body: presentationBody, fileName }
  );
  const title = page.node.label || metadata.title || fileName.replace(/\.md$/iu, "");
  const summary = readString(profile?.summary) ?? suggestions?.description ?? null;
  const common = {
    id: source.publicId,
    fileId: source.publicId,
    path: page.node.logicalPath,
    title,
    summary
  };
  if (projectionKind === "search") {
    return {
      ...common,
      type: metadata.type,
      description: metadata.description ?? null,
      tags: metadata.tags ?? [],
      resource: metadata.resource ?? null,
      timestamp: metadata.timestamp ?? null,
      subjects: readStringList(profile?.subjects),
      entities: readStringList(profile?.entities),
      headings: readStringList(profile?.headingOutline),
      keywords: readStringList(profile?.keywords),
      language: readString(profile?.language),
      metadata
    };
  }
  if (projectionKind === "manifest") {
    return {
      ...common,
      contentType: revision.contentType,
      sourceRevisionId: revision.publicId,
      resourceRevision: source.revision,
      checksumSha256: revision.checksum,
      metadata
    };
  }
  if (projectionKind === "tree") {
    return {
      ...common,
      name: fileName,
      parentPath: parentPath(page.node.logicalPath),
      kind: "file",
      directEntryCount: 0,
      directDirectoryCount: 0,
      directFileCount: 0,
      descendantFileCount: 0
    };
  }
  if (projectionKind === "graph_node") {
    return {
      ...common,
      type: page.node.kind,
      description: summary,
      subjects: readStringList(profile?.subjects),
      tags: readStringList(page.node.metadata.tags),
      entities: readStringList(profile?.entities),
      explicitReferences: readStringList(profile?.explicitReferences),
      relationshipHints: readStringList(profile?.relationshipHints),
      headings: readStringList(profile?.headingOutline),
      keywords: readStringList(profile?.keywords),
      language: readString(profile?.language),
      profileVersion: readString(profile?.profileVersion),
      profileSource: readString(profile?.profileSource),
      metadata: page.node.metadata
    };
  }
  const nodes = new Map(page.endpointNodes.map((node) => [node.publicId, node]));
  const relationships = deduplicateGraphRelationships(page.neighborhood.map((edge) => {
    const from = nodes.get(edge.fromNodePublicId);
    const to = nodes.get(edge.toNodePublicId);
    if (!from || !to || !edge.source?.trim()) {
      throw machineProjectionError("graph_endpoint_conflict");
    }
    return presentGraphRelationship({
      from: endpoint(from),
      to: endpoint(to),
      relationType: edge.relation,
      weight: edge.weight,
      reason: edge.reason ?? "",
      source: edge.source,
      ...(edge.metadata ? { evidence: edge.metadata } : {})
    }, source.publicId);
  })).slice(0, relatedFileLimit);
  return {
    ...common,
    relationships: relationships.map((relationship) => ({
      fileId: relationship.fileId,
      path: relationship.path,
      title: relationship.title,
      relationType: relationship.relationType,
      direction: relationship.direction,
      weight: relationship.weight,
      reason: relationship.reason,
      source: relationship.source,
      evidence: relationship.evidence ?? {}
    }))
  };
}

function directoryRecord(
  directory: StorageVnextPublicationDirectoryInput
): JsonProjectionRecord {
  const relativePath = directory.directoryPath === "pages"
    ? ""
    : directory.directoryPath.slice("pages/".length);
  const entries = directory.leaves.flatMap((leaf) => leaf.entries);
  return {
    id: `directory:${relativePath}`,
    directoryId: directory.directoryPublicId ?? "directory:",
    sourceDirectoryId: directory.directoryPublicId,
    path: directory.directoryPath,
    name: relativePath.split("/").at(-1) || "pages",
    parentPath: parentPath(directory.directoryPath),
    kind: "directory",
    resourceRevision: 1,
    directEntryCount: directory.entryCount,
    directDirectoryCount: entries.filter((entry) => entry.kind === "directory").length,
    directFileCount: entries.filter((entry) => entry.kind === "file").length,
    descendantFileCount: directory.descendantFileCount
  };
}

function edgeRecord(
  projectionKind: "links" | "graph_edge",
  edge: StorageVnextGraphEdgeFact,
  from: StorageVnextGraphNodeFact,
  to: StorageVnextGraphNodeFact
): JsonProjectionRecord {
  if (projectionKind === "links") {
    return {
      id: edge.publicId,
      path: from.logicalPath,
      from: from.logicalPath,
      to: to.logicalPath,
      label: to.label,
      fromFileId: from.sourceFilePublicId,
      toFileId: to.sourceFilePublicId,
      relation_type: edge.relation,
      weight: edge.weight,
      source: edge.source ?? "deterministic",
      reason: edge.reason ?? ""
    };
  }
  return {
    id: edge.publicId,
    fromFileId: from.sourceFilePublicId,
    fromPath: from.logicalPath,
    fromTitle: from.label,
    toFileId: to.sourceFilePublicId,
    toPath: to.logicalPath,
    toTitle: to.label,
    relationType: edge.relation,
    weight: edge.weight,
    reason: edge.reason ?? "",
    source: edge.source ?? "deterministic",
    evidence: edge.metadata ?? {}
  };
}

async function loadEndpoints(
  input: Pick<Parameters<typeof assembleStorageVnextMachineProjection>[0], "getNode">,
  edge: StorageVnextGraphEdgeFact
): Promise<{ from: StorageVnextGraphNodeFact; to: StorageVnextGraphNodeFact }> {
  const [from, to] = await Promise.all([
    input.getNode(edge.fromNodePublicId),
    input.getNode(edge.toNodePublicId)
  ]);
  if (!from || !to) throw machineProjectionError("graph_endpoint_conflict");
  return { from, to };
}

function shardCount(
  counts: Parameters<typeof assembleStorageVnextMachineProjection>[0]["shardCounts"],
  kind: "search" | "manifest" | "tree" | "graph_node" | "links" | "graph_edge"
): number {
  if (kind === "graph_node") return counts.graphNode;
  if (kind === "graph_edge") return counts.graphEdge;
  return counts[kind];
}

function encodeArtifact(
  projectionKind: string,
  shardKey: string,
  records: JsonProjectionRecord[]
): Uint8Array {
  return Buffer.from(renderShard(projectionKind, shardKey, records), "utf8");
}

function artifact(
  logicalPath: string,
  kind: "index" | "graph",
  bytes: Uint8Array
): StorageVnextPublicationArtifact {
  return { logicalPath, kind, sourceFilePublicId: null, ordinal: 0, bytes };
}

function assertArtifactBytes(bytes: Uint8Array, maximum: number): void {
  if (bytes.byteLength > maximum) {
    throw machineProjectionError("artifact_byte_budget_exceeded");
  }
}

function endpoint(node: StorageVnextGraphNodeFact) {
  return { fileId: node.sourceFilePublicId, path: node.logicalPath, title: node.label };
}

function readPresentationSuggestions(
  value: StorageVnextPublicValue | undefined
): SourceMetadataSuggestions | null {
  const document = readDocument(value);
  const description = readString(document?.description);
  return description ? { description } : null;
}

function readDocument(
  value: StorageVnextPublicValue | undefined
): StorageVnextPublicDocument | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as StorageVnextPublicDocument
    : null;
}

function readString(value: StorageVnextPublicValue | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringList(value: StorageVnextPublicValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function compareRecords(left: JsonProjectionRecord, right: JsonProjectionRecord): number {
  return compareUtf8(left.id, right.id);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Storage vNext machine projection aborted", "AbortError");
}

function machineProjectionError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext machine projection error: ${code}`),
    { code }
  );
}
