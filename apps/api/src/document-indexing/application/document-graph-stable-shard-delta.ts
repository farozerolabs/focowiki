import { createHash } from "node:crypto";
import {
  portableDirectoryResourceSubject,
  portableSemanticResourceFileName
} from "@focowiki/okf";
import {
  buildDocumentSemanticPacketPages,
  type DocumentSemanticMachinePage,
  type DocumentSemanticPartDescriptor
} from "./document-semantic-resource-packets.js";
import { documentGraphRelationshipKey } from
  "./document-graph-projection.js";
import { directoryResourceTitle } from
  "./document-machine-projection-shared.js";
import { partitionStableShardRuns, selectStableShardOwners } from
  "./document-stable-shard-runs.js";

export type DocumentGraphBaseRouter = Readonly<{
  relationshipCount: number;
  childDirectories: readonly Readonly<{
    title: string;
    scopePath: string;
    path: string;
  }>[];
  resources: readonly DocumentSemanticPartDescriptor[];
}>;

export type DocumentGraphStableShardDelta = Readonly<{
  pages: readonly DocumentSemanticMachinePage[];
  descriptors: readonly DocumentSemanticPartDescriptor[];
  removedPaths: readonly string[];
  relationshipCount: number;
}>;

export type DocumentGraphStableShardDeltaStreamResult =
  DocumentGraphStableShardDelta & Readonly<{
    metrics: Readonly<{
      changedRecordCount: number;
      chunkCount: number;
      peakBufferedRecordCount: number;
      touchedShardCount: number;
    }>;
  }>;

export function createDocumentGraphStableShardDeltaStream(input: Readonly<{
  scopePath: string;
  machineDirectory: string;
  base: DocumentGraphBaseRouter;
  maximumRecords: number;
  maximumBytes: number;
  readRecords(path: string): Promise<readonly Record<string, unknown>[]>;
  checkpoint?(): Promise<void>;
}>) {
  if (!Number.isSafeInteger(input.maximumRecords) || input.maximumRecords < 1
    || !Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
    throw stableDeltaError("graph_delta_stream_limits_invalid");
  }
  let current = input.base;
  const originalPaths = new Set(input.base.resources.map((item) => item.path));
  const latestPages = new Map<string, DocumentSemanticMachinePage>();
  const changedKeys = new Set<string>();
  const touchedPaths = new Set<string>();
  let changedRecordCount = 0;
  let chunkCount = 0;
  let peakBufferedRecordCount = 0;

  async function readCurrentRecords(path: string) {
    const page = latestPages.get(path);
    if (!page) return input.readRecords(path);
    const parsed = JSON.parse(new TextDecoder().decode(page.bytes)) as {
      relationships?: unknown;
    };
    if (!Array.isArray(parsed.relationships)) {
      throw stableDeltaError("graph_delta_stream_page_invalid");
    }
    return parsed.relationships as Record<string, unknown>[];
  }

  async function applyChunk(
    changedRecords: readonly Record<string, unknown>[],
    removedRecordKeys: readonly string[]
  ): Promise<void> {
    if (changedRecords.length === 0 && removedRecordKeys.length === 0) return;
    peakBufferedRecordCount = Math.max(
      peakBufferedRecordCount,
      changedRecords.length,
      removedRecordKeys.length
    );
    chunkCount += 1;
    const delta = await applyDocumentGraphStableShardDelta({
      scopePath: input.scopePath,
      machineDirectory: input.machineDirectory,
      base: current,
      changedRecords,
      removedRecordKeys,
      maximumRecords: input.maximumRecords,
      maximumBytes: input.maximumBytes,
      readRecords: readCurrentRecords,
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {})
    });
    delta.removedPaths.forEach((path) => latestPages.delete(path));
    delta.pages.forEach((page) => {
      latestPages.set(page.logicalPath, page);
      touchedPaths.add(page.logicalPath);
    });
    current = {
      ...current,
      relationshipCount: delta.relationshipCount,
      resources: delta.descriptors
    };
  }

  return {
    async append(records: readonly Record<string, unknown>[]): Promise<void> {
      changedRecordCount += records.length;
      records.forEach((record) => changedKeys.add(
        documentGraphRelationshipKey(record)
      ));
      for (let offset = 0; offset < records.length;
        offset += input.maximumRecords) {
        await applyChunk(records.slice(offset, offset + input.maximumRecords), []);
      }
    },
    async remove(recordKeys: readonly string[]): Promise<void> {
      const removals = recordKeys.filter((key) => !changedKeys.has(key));
      for (let offset = 0; offset < removals.length;
        offset += input.maximumRecords) {
        await applyChunk([], removals.slice(offset, offset + input.maximumRecords));
      }
    },
    async finish(
      removedRecordKeys: readonly string[]
    ): Promise<DocumentGraphStableShardDeltaStreamResult> {
      await this.remove(removedRecordKeys);
      const finalPaths = new Set(current.resources.map((item) => item.path));
      const pages = [...latestPages.values()]
        .filter((page) => finalPaths.has(page.logicalPath))
        .sort((left, right) => compareText(left.logicalPath, right.logicalPath));
      return {
        pages,
        descriptors: current.resources,
        removedPaths: [...originalPaths]
          .filter((path) => !finalPaths.has(path)).sort(compareText),
        relationshipCount: current.relationshipCount,
        metrics: {
          changedRecordCount,
          chunkCount,
          peakBufferedRecordCount,
          touchedShardCount: touchedPaths.size
        }
      };
    }
  };
}

export async function applyDocumentGraphStableShardDelta(input: Readonly<{
  scopePath: string;
  machineDirectory: string;
  base: DocumentGraphBaseRouter;
  changedRecords: readonly Record<string, unknown>[];
  removedRecordKeys: readonly string[];
  maximumRecords: number;
  maximumBytes: number;
  readRecords(path: string): Promise<readonly Record<string, unknown>[]>;
  checkpoint?(): Promise<void>;
}>): Promise<DocumentGraphStableShardDelta> {
  const changes = new Map(input.changedRecords.map((record) => [
    documentGraphRelationshipKey(record), record
  ]));
  const changedKeys = [...new Set([
    ...changes.keys(), ...input.removedRecordKeys
  ])].sort(compareText);
  if (changedKeys.length === 0) {
    return {
      pages: [],
      descriptors: input.base.resources,
      removedPaths: [],
      relationshipCount: input.base.relationshipCount
    };
  }
  const touched = selectTouchedDescriptors(input.base.resources, changedKeys);
  const runs = partitionStableShardRuns(input.base.resources, touched);
  const pages: DocumentSemanticMachinePage[] = [];
  const updated: DocumentSemanticPartDescriptor[] = [];
  const removedPaths: string[] = [];
  const usedPaths = new Set(input.base.resources.map((item) => item.path));
  for (const run of runs.length > 0 ? runs : [[]]) {
    const runPaths = new Set(run.map((item) => item.path));
    const runKeys = changedKeys.filter((key) => selectStableShardOwners(
      input.base.resources, key).some((owner) => runPaths.has(owner.path))
      || input.base.resources.length === 0);
    const records = new Map<string, Record<string, unknown>>();
    for (const descriptor of run) {
      for (const record of await input.readRecords(descriptor.path)) {
        records.set(documentGraphRelationshipKey(record), record);
      }
      await input.checkpoint?.();
    }
    runKeys.filter((key) => input.removedRecordKeys.includes(key))
      .forEach((key) => records.delete(key));
    runKeys.forEach((key) => {
      const record = changes.get(key);
      if (record) records.set(key, record);
    });
    const packet = buildDocumentSemanticPacketPages({
      family: "relationship_packet", directoryPath: input.machineDirectory,
      subject: portableDirectoryResourceSubject(input.scopePath),
      title: directoryResourceTitle(input.scopePath, "relationships"),
      scopePath: input.scopePath, records: [...records.values()],
      recordKey: documentGraphRelationshipKey,
      maximumRecords: input.maximumRecords, maximumBytes: input.maximumBytes
    });
    const paths = allocateStablePaths({
      machineDirectory: input.machineDirectory, scopePath: input.scopePath,
      existing: input.base.resources, touched: run,
      count: packet.pages.length, usedPaths
    });
    const runPages = packet.pages.map((page, index) =>
      withPath(page, paths[index]!));
    pages.push(...runPages);
    updated.push(...packet.descriptors.map((descriptor, index) => ({
      ...descriptor, path: paths[index]!, byteCount: runPages[index]!.byteCount
    })));
    const retained = new Set(paths);
    removedPaths.push(...run.map((item) => item.path)
      .filter((path) => !retained.has(path)));
  }
  const touchedPaths = new Set(touched.map((descriptor) => descriptor.path));
  const descriptors = [
    ...input.base.resources.filter((descriptor) =>
      !touchedPaths.has(descriptor.path)),
    ...updated
  ].sort((left, right) => compareText(left.firstKey, right.firstKey)
    || compareText(left.path, right.path));
  return {
    pages,
    descriptors,
    removedPaths: removedPaths.sort(compareText),
    relationshipCount: descriptors.reduce(
      (total, descriptor) => total + descriptor.recordCount, 0
    )
  };
}

function selectTouchedDescriptors(
  descriptors: readonly DocumentSemanticPartDescriptor[],
  keys: readonly string[]
): DocumentSemanticPartDescriptor[] {
  if (descriptors.length === 0) return [];
  const selected = new Set<DocumentSemanticPartDescriptor>();
  for (const key of keys) {
    selectStableShardOwners(descriptors, key)
      .forEach((descriptor) => selected.add(descriptor));
  }
  return [...selected].sort((left, right) =>
    compareText(left.firstKey, right.firstKey));
}

function allocateStablePaths(input: Readonly<{
  machineDirectory: string;
  scopePath: string;
  existing: readonly DocumentSemanticPartDescriptor[];
  touched: readonly DocumentSemanticPartDescriptor[];
  count: number;
  usedPaths: Set<string>;
}>): string[] {
  const paths = input.touched.slice(0, input.count)
    .map((descriptor) => descriptor.path);
  if (paths.length === 0 && input.existing.length === 0 && input.count > 0) {
    paths.push(`${input.machineDirectory}/${portableSemanticResourceFileName({
      subject: portableDirectoryResourceSubject(input.scopePath),
      family: "relationships"
    })}`);
  }
  let nextPart = Math.max(1, ...input.existing.map((descriptor) =>
    partNumber(descriptor.path))) + 1;
  while (paths.length < input.count) {
    const path = `${input.machineDirectory}/${portableSemanticResourceFileName({
      subject: portableDirectoryResourceSubject(input.scopePath),
      family: "relationships",
      partNumber: nextPart
    })}`;
    nextPart += 1;
    if (input.usedPaths.has(path)) continue;
    paths.push(path);
    input.usedPaths.add(path);
  }
  return paths;
}

function partNumber(path: string): number {
  const match = path.match(/-part-(\d+)\.json$/u);
  return match ? Number(match[1]) : 1;
}

function withPath(
  page: DocumentSemanticMachinePage,
  logicalPath: string
): DocumentSemanticMachinePage {
  return {
    ...page,
    logicalPath,
    normalizedPath: logicalPath.toLocaleLowerCase("en-US"),
    checksumSha256: createHash("sha256").update(page.bytes).digest("hex")
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableDeltaError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Graph stable delta error: ${code}`), { code });
}
