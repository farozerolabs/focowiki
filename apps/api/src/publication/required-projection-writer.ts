import { resolveSourceMetadata } from "@focowiki/okf";
import type { ClaimedPublicationImpact } from "../application/ports/publication-impact-repository.js";
import type { SerializableJson } from "../application/ports/source-dispatch-repository.js";
import type {
  ProjectionRecordKind,
  ProjectionRecordRepository
} from "../application/ports/projection-record-repository.js";
import type { PublicationProjectionInput } from "../application/ports/publication-projection-input.js";
import type { GenerationObjectReferenceRepository } from "../application/ports/generation-object-reference-repository.js";
import { generatedPagePath } from "../domain/source-path.js";
import { createGeneratedFileId } from "../domain/generated-file-id.js";
import type { StorageAdapter } from "../storage/s3.js";
import type { ImmutableObjectWriteResult } from "./immutable-object-writer.js";
import type { JsonProjectionRecord } from "./json-projection-shard-writer.js";
import {
  applyPresentationSuggestions,
  renderPageFile
} from "../okf/publication-files.js";

type JsonShardWriter = {
  apply: (input: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
    recordId: string;
    record: JsonProjectionRecord | null;
    logicalPath: string;
  }) => Promise<{ deleted: boolean; recordCount: number; reused: boolean }>;
  applyBatch: (input: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
    changes: Array<{ recordId: string; record: JsonProjectionRecord | null }>;
    logicalPath: string;
  }) => Promise<{ deleted: boolean; recordCount: number; reused: boolean }>;
};

export type RequiredProjectionWriteResult = {
  handled: boolean;
  touchedShardCount: number;
};

export function createRequiredProjectionWriter(input: {
  records: ProjectionRecordRepository;
  references: GenerationObjectReferenceRepository;
  immutableObjects: {
    write: (input: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }) => Promise<ImmutableObjectWriteResult>;
  };
  shards: JsonShardWriter;
  storage: Pick<StorageAdapter, "getObjectText">;
  relatedFileLimit: number;
}) {
  assertPositiveInteger(input.relatedFileLimit, "relatedFileLimit");

  const writer = {
    async write(impact: ClaimedPublicationImpact): Promise<RequiredProjectionWriteResult> {
      if (impact.projectionKind === "page") {
        await writePage(input, impact);
        return { handled: true, touchedShardCount: 0 };
      }
      if (isMachineProjection(impact.projectionKind)) {
        await writeMachineProjection(input, impact);
        return { handled: true, touchedShardCount: 1 };
      }
      return { handled: false, touchedShardCount: 0 };
    },
    async writeBatch(impacts: ClaimedPublicationImpact[]): Promise<RequiredProjectionWriteResult> {
      if (impacts.length === 0 || !impacts.every((impact) => isMachineProjection(impact.projectionKind))) {
        return { handled: false, touchedShardCount: 0 };
      }
      await writeMachineProjectionBatch(input, impacts);
      return { handled: true, touchedShardCount: 1 };
    }
  };
  return writer;
}

async function writePage(
  input: Parameters<typeof createRequiredProjectionWriter>[0],
  impact: ClaimedPublicationImpact
): Promise<void> {
  if (impact.action === "delete") {
    const sourcePath = impact.previousPath ?? impact.path;
    await input.references.stageDelete({
      knowledgeBaseId: impact.knowledgeBaseId,
      generationId: impact.generationId,
      refKind: "page",
      refKey: impact.recordIdentity,
      logicalPath: sourcePath ? generatedPagePath(sourcePath) : null,
      sourceFileId: impact.sourceFileId
    });
    return;
  }
  const projectionInput = requireProjectionInput(impact, "source");
  const source = projectionInput.document;
  const content = await input.storage.getObjectText(source.objectKey);
  if (content === null) {
    throw new Error("Source object is unavailable for page projection");
  }
  const resolved = resolveSourceMetadata({
    fileName: source.name,
    content,
    metadata: source.metadata,
    suggestions: source.suggestions
  });
  const metadata = applyPresentationSuggestions(
    resolved.metadata,
    source.suggestions,
    {
      body: source.graphNode?.summary ?? source.graphNode?.description ?? resolved.body,
      fileName: source.name
    }
  );
  const relationships = projectionInput.relationships.slice(0, input.relatedFileLimit);
  const body = renderPageFile({
    pagePath: source.generatedPath,
    fileId: source.sourceFileId,
    metadata,
    suggestions: source.suggestions,
    graphLinks: relationships
  }, resolved.body);
  const object = await input.immutableObjects.write({
    body,
    contentType: "text/markdown; charset=utf-8"
  });
  await input.references.stageUpsert({
    knowledgeBaseId: impact.knowledgeBaseId,
    generationId: impact.generationId,
    refKind: "page",
    refKey: source.sourceFileId,
    fileId: createGeneratedFileId({
      refKind: "page",
      refKey: source.sourceFileId,
      sourceFileId: source.sourceFileId
    }),
    checksumSha256: object.checksumSha256,
    formatVersion: object.formatVersion,
    logicalPath: source.generatedPath,
    sourceFileId: source.sourceFileId,
    projectionShardId: null
  });
}

async function writeMachineProjection(
  input: Parameters<typeof createRequiredProjectionWriter>[0],
  impact: ClaimedPublicationImpact
): Promise<void> {
  await writeMachineProjectionBatch(input, [impact]);
}

async function writeMachineProjectionBatch(
  input: Parameters<typeof createRequiredProjectionWriter>[0],
  impacts: ClaimedPublicationImpact[]
): Promise<void> {
  const first = impacts[0];
  if (!first) throw new Error("Machine projection batch must not be empty");
  const projectionKind = normalizeMachineProjectionKind(first.projectionKind);
  const shardKey = machineShardKey(first);
  if (impacts.some((impact) =>
    normalizeMachineProjectionKind(impact.projectionKind) !== projectionKind
    || machineShardKey(impact) !== shardKey
  )) {
    throw new Error("Machine projection batch must target one shard");
  }
  const changes: Array<{ recordId: string; record: JsonProjectionRecord | null }> = [];
  for (const impact of impacts) {
    const descriptor = impact.action === "delete"
      ? null
      : await buildMachineRecord(impact, input.relatedFileLimit);
    const record = impact.action === "delete" ? null : descriptor?.record ?? null;
    changes.push({ recordId: impact.recordIdentity, record });
    await stageMachineRecord(input.records, impact, {
      projectionKind,
      shardKey,
      descriptor,
      record
    });
  }
  await input.shards.applyBatch({
    knowledgeBaseId: first.knowledgeBaseId,
    generationId: first.generationId,
    projectionKind,
    shardKey,
    changes,
    logicalPath: machineShardPath(projectionKind, shardKey)
  });
}

async function stageMachineRecord(
  records: ProjectionRecordRepository,
  impact: ClaimedPublicationImpact,
  input: {
    projectionKind: ProjectionRecordKind;
    shardKey: string;
    descriptor: Awaited<ReturnType<typeof buildMachineRecord>>;
    record: JsonProjectionRecord | null;
  }
): Promise<void> {
  const { projectionKind, shardKey, descriptor, record } = input;
  if (!record || !descriptor) {
    await records.stageDelete({
      knowledgeBaseId: impact.knowledgeBaseId,
      generationId: impact.generationId,
      projectionKind,
      recordId: impact.recordIdentity,
      shardKey
    });
    return;
  }
  await records.stageUpsert({
    knowledgeBaseId: impact.knowledgeBaseId,
    generationId: impact.generationId,
    projectionKind,
    recordId: impact.recordIdentity,
    shardKey,
    sourceFileId: descriptor.sourceFileId,
    relatedSourceFileId: descriptor.relatedSourceFileId,
    logicalPath: descriptor.logicalPath,
    parentPath: descriptor.parentPath,
    sortKey: descriptor.sortKey,
    title: descriptor.title,
    summary: descriptor.summary,
    searchableText: descriptor.searchableText,
    payload: toSerializableJson(record)
  });
}

function machineShardKey(impact: ClaimedPublicationImpact): string {
  return impact.projectionKind === "graph_reverse_neighbor"
    ? impact.recordIdentity
    : impact.projectionKey;
}

async function buildMachineRecord(
  impact: ClaimedPublicationImpact,
  relatedFileLimit: number
): Promise<{
  record: JsonProjectionRecord;
  sourceFileId: string | null;
  relatedSourceFileId: string | null;
  logicalPath: string | null;
  parentPath: string | null;
  sortKey: string | null;
  title: string | null;
  summary: string | null;
  searchableText: string | null;
} | null> {
  if (impact.projectionInput?.kind === "empty") return null;
  if (impact.projectionKind === "tree" && impact.recordIdentity.startsWith("directory:")) {
    const input = requireProjectionInput(impact, "directory");
    const directory = input.directory;
    if (!directory.relativePath) {
      const record = {
        id: impact.recordIdentity,
        directoryId: "directory:",
        sourceDirectoryId: null,
        path: "pages",
        name: "pages",
        parentPath: "",
        kind: "directory",
        resourceRevision: 1,
        childCount: 0,
        directFileCount: 0,
        descendantFileCount: directory.descendantFileCount
      } satisfies JsonProjectionRecord;
      return {
        record,
        sourceFileId: null,
        relatedSourceFileId: null,
        logicalPath: "pages",
        parentPath: "",
        sortKey: "pages",
        title: "pages",
        summary: null,
        searchableText: searchableText(record)
      };
    }
    const logicalPath = `pages/${directory.relativePath}`;
    const record = {
      id: impact.recordIdentity,
      directoryId: directory.id,
      sourceDirectoryId: directory.sourceDirectoryId,
      path: logicalPath,
      name: directory.name,
      parentPath: parentPath(logicalPath),
      kind: "directory",
      resourceRevision: directory.resourceRevision,
      childCount: directory.childCount,
      directFileCount: directory.directFileCount,
      descendantFileCount: directory.descendantFileCount
    } satisfies JsonProjectionRecord;
    return {
      record,
      sourceFileId: null,
      relatedSourceFileId: null,
      logicalPath,
      parentPath: parentPath(logicalPath),
      sortKey: logicalPath.toLowerCase(),
      title: directory.name,
      summary: null,
      searchableText: searchableText(record)
    };
  }

  if (impact.projectionKind === "graph_edge" || impact.projectionKind === "links") {
    const edge = requireProjectionInput(impact, "graph_edge").edge;
    if (impact.projectionKind === "links") {
      const record = {
        id: impact.recordIdentity,
        path: edge.fromPath,
        from: edge.fromPath,
        to: edge.toPath,
        label: edge.toTitle,
        fromFileId: edge.fromFileId,
        toFileId: edge.toFileId,
        relation_type: edge.relationType,
        weight: edge.weight,
        source: edge.source,
        reason: edge.reason
      } satisfies JsonProjectionRecord;
      return {
        record,
        sourceFileId: edge.fromFileId,
        relatedSourceFileId: edge.toFileId,
        logicalPath: edge.fromPath,
        parentPath: null,
        sortKey: impact.recordIdentity,
        title: `${edge.fromTitle} -> ${edge.toTitle}`,
        summary: edge.reason,
        searchableText: searchableText(record)
      };
    }
    return {
      record: {
        id: impact.recordIdentity,
        fromFileId: edge.fromFileId,
        fromPath: edge.fromPath,
        fromTitle: edge.fromTitle,
        toFileId: edge.toFileId,
        toPath: edge.toPath,
        toTitle: edge.toTitle,
        relationType: edge.relationType,
        weight: edge.weight,
        reason: edge.reason,
        source: edge.source,
        evidence: edge.evidence ?? {}
      },
      sourceFileId: edge.fromFileId,
      relatedSourceFileId: edge.toFileId,
      logicalPath: edge.fromPath,
      parentPath: null,
      sortKey: impact.recordIdentity,
      title: `${edge.fromTitle} -> ${edge.toTitle}`,
      summary: edge.reason,
      searchableText: [edge.fromTitle, edge.toTitle, edge.relationType, edge.reason].join(" ")
    };
  }

  const projectionInput = requireProjectionInput(impact, "source");
  const source = projectionInput.document;
  const node = source.graphNode;
  const presentationBody = node?.summary ?? node?.description ?? "";
  const resolved = resolveSourceMetadata({
    fileName: source.name,
    content: presentationBody,
    metadata: source.metadata,
    suggestions: source.suggestions
  });
  const presentationMetadata = applyPresentationSuggestions(
    resolved.metadata,
    source.suggestions,
    {
      body: presentationBody,
      fileName: source.name
    }
  );
  const title = node?.title ?? presentationMetadata.title ?? source.name.replace(/\.md$/iu, "");
  const summary = node?.summary ?? node?.description ?? source.suggestions?.description ?? null;
  const common = {
    id: source.sourceFileId,
    fileId: source.sourceFileId,
    path: source.generatedPath,
    title,
    summary,
    contentPath: source.generatedPath
  };
  let record: JsonProjectionRecord;
  if (impact.projectionKind === "search") {
    record = {
      ...common,
      type: presentationMetadata.type,
      description: presentationMetadata.description ?? null,
      tags: presentationMetadata.tags ?? [],
      resource: presentationMetadata.resource ?? null,
      timestamp: presentationMetadata.timestamp ?? null,
      subjects: node?.subjects ?? [],
      entities: node?.entities ?? [],
      headings: node?.headings ?? [],
      keywords: node?.keywords ?? source.suggestions?.keywords ?? [],
      language: node?.language ?? null,
      metadata: presentationMetadata
    };
  } else if (impact.projectionKind === "manifest") {
    record = {
      ...common,
      contentType: "text/markdown; charset=utf-8",
      sourceRevisionId: source.sourceRevisionId,
      resourceRevision: source.resourceRevision,
      checksumSha256: source.checksumSha256,
      metadata: presentationMetadata
    };
  } else if (impact.projectionKind === "tree") {
    record = {
      ...common,
      name: source.name,
      parentPath: parentPath(source.generatedPath),
      kind: "file"
    };
  } else if (impact.projectionKind === "graph_node") {
    record = { ...common, ...(node ?? {}), id: source.sourceFileId };
  } else {
    const relationships = projectionInput.relationships.slice(0, relatedFileLimit);
    record = {
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
  return {
    record,
    sourceFileId: source.sourceFileId,
    relatedSourceFileId: null,
    logicalPath: source.generatedPath,
    parentPath: impact.projectionKind === "tree" ? parentPath(source.generatedPath) : null,
    sortKey: source.generatedPath.toLowerCase(),
    title,
    summary,
    searchableText: searchableText(record)
  };
}

function requireProjectionInput<K extends PublicationProjectionInput["kind"]>(
  impact: ClaimedPublicationImpact,
  kind: K
): Extract<PublicationProjectionInput, { kind: K }> {
  if (!impact.projectionInput || impact.projectionInput.kind !== kind) {
    throw new Error(`Publication impact is missing its frozen ${kind} input`);
  }
  return impact.projectionInput as Extract<PublicationProjectionInput, { kind: K }>;
}

function isMachineProjection(kind: ClaimedPublicationImpact["projectionKind"]): boolean {
  return [
    "search", "links", "manifest", "tree", "graph_node", "graph_edge",
    "graph_reverse_neighbor", "related_files"
  ].includes(kind);
}

function normalizeMachineProjectionKind(
  kind: ClaimedPublicationImpact["projectionKind"]
): ProjectionRecordKind {
  return kind === "graph_reverse_neighbor" ? "related_files" : kind as ProjectionRecordKind;
}

function machineShardPath(kind: ProjectionRecordKind, shardKey: string): string {
  if (kind === "related_files") {
    return `_graph/by-file/${encodeURIComponent(shardKey)}.json`;
  }
  if (kind === "graph_node" || kind === "graph_edge") {
    return `_graph/${shardKey}.json`;
  }
  return `_index/${shardKey}.json`;
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function searchableText(record: JsonProjectionRecord): string {
  return JSON.stringify(record).replace(/[{}\[\]",:]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function toSerializableJson(value: unknown): SerializableJson {
  return JSON.parse(JSON.stringify(value)) as SerializableJson;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
