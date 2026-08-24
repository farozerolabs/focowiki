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
