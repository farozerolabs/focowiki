import { createHash } from "node:crypto";
import { comparePortableRecordKeys, portableDirectoryResourceSubject,
  portableIndexDirectoryPath,
  portableSemanticResourceFileName } from "@focowiki/okf";
import { buildDocumentSemanticPacketPages,
  type DocumentSemanticMachinePage,
  type DocumentSemanticPartDescriptor } from
  "./document-semantic-resource-packets.js";
import { asString, directoryResourceTitle } from
  "./document-machine-projection-shared.js";
import { partitionStableShardRuns, selectStableShardOwners } from
  "./document-stable-shard-runs.js";

export async function applyDocumentRecordStableShardDelta(input: Readonly<{
  scopePath: string;
  baseResources: readonly DocumentSemanticPartDescriptor[];
  changedRecords: readonly Record<string, unknown>[];
  removedRecordPaths: readonly string[];
  maximumRecords: number;
  maximumBytes: number;
  readRecords(path: string): Promise<readonly Record<string, unknown>[]>;
  checkpoint?(): Promise<void>;
}>) {
  const changes = new Map(input.changedRecords.map((record) => [
    recordKey(record), record
  ]));
  const changedKeys = [...new Set([
    ...changes.keys(), ...input.removedRecordPaths
  ])].sort(comparePortableRecordKeys);
  if (changedKeys.length === 0) return {
    pages: [] as DocumentSemanticMachinePage[],
    descriptors: input.baseResources,
    removedPaths: [] as string[],
    recordCount: input.baseResources.reduce(
      (total, item) => total + item.recordCount, 0)
  };
  const touched = selectTouched(input.baseResources, changedKeys);
  const machineDirectory = portableIndexDirectoryPath(input.scopePath);
  const runs = partitionStableShardRuns(input.baseResources, touched);
  const pages: DocumentSemanticMachinePage[] = [];
  const updated: DocumentSemanticPartDescriptor[] = [];
  const removedPaths: string[] = [];
  const usedPaths = new Set(input.baseResources.map((item) => item.path));
  for (const run of runs.length > 0 ? runs : [[]]) {
    const runPaths = new Set(run.map((item) => item.path));
    const runKeys = changedKeys.filter((key) => selectStableShardOwners(
      input.baseResources, key).some((owner) => runPaths.has(owner.path))
      || input.baseResources.length === 0);
    const records = new Map<string, Record<string, unknown>>();
    for (const descriptor of run) {
      for (const record of await input.readRecords(descriptor.path)) {
        records.set(recordKey(record), record);
      }
      await input.checkpoint?.();
    }
    runKeys.filter((key) => input.removedRecordPaths.includes(key))
      .forEach((key) => records.delete(key));
    runKeys.forEach((key) => {
      const record = changes.get(key);
      if (record) records.set(key, record);
    });
    const packet = buildDocumentSemanticPacketPages({
      family: "document_packet", directoryPath: machineDirectory,
      subject: portableDirectoryResourceSubject(input.scopePath),
      title: directoryResourceTitle(input.scopePath, "documents"),
      scopePath: input.scopePath, records: [...records.values()], recordKey,
      maximumRecords: input.maximumRecords,
      maximumBytes: input.maximumBytes
    });
    const paths = allocatePaths({
      machineDirectory, scopePath: input.scopePath,
      existing: input.baseResources, touched: run,
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
  const touchedPaths = new Set(touched.map((item) => item.path));
  const descriptors = [
    ...input.baseResources.filter((item) => !touchedPaths.has(item.path)),
    ...updated
  ].sort((left, right) => comparePortableRecordKeys(
    left.firstKey, right.firstKey)
    || comparePortableRecordKeys(left.path, right.path));
  return {
    pages,
    descriptors,
    removedPaths: removedPaths.sort(comparePortableRecordKeys),
    recordCount: descriptors.reduce(
      (total, item) => total + item.recordCount, 0)
  };
}

function recordKey(record: Readonly<Record<string, unknown>>): string {
  const path = asString(record.path);
  if (!path) throw deltaError("document_delta_record_invalid");
  return path;
}

function selectTouched(
  descriptors: readonly DocumentSemanticPartDescriptor[],
  keys: readonly string[]
) {
  if (descriptors.length === 0) return [];
  const selected = new Set(keys.flatMap((key) =>
    selectStableShardOwners(descriptors, key)));
  return [...selected].sort((left, right) =>
    comparePortableRecordKeys(left.firstKey, right.firstKey));
}

function allocatePaths(input: Readonly<{
  machineDirectory: string;
  scopePath: string;
  existing: readonly DocumentSemanticPartDescriptor[];
  touched: readonly DocumentSemanticPartDescriptor[];
  count: number;
  usedPaths: Set<string>;
}>) {
  const paths = input.touched.slice(0, input.count).map((item) => item.path);
  if (paths.length === 0 && input.existing.length === 0 && input.count > 0) {
    paths.push(`${input.machineDirectory}/${portableSemanticResourceFileName({
      subject: portableDirectoryResourceSubject(input.scopePath),
      family: "documents"
    })}`);
  }
  let nextPart = Math.max(1, ...input.existing.map((item) =>
    partNumber(item.path))) + 1;
  while (paths.length < input.count) {
    const path = `${input.machineDirectory}/${portableSemanticResourceFileName({
      subject: portableDirectoryResourceSubject(input.scopePath),
      family: "documents",
      partNumber: nextPart++
    })}`;
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

function withPath(page: DocumentSemanticMachinePage, logicalPath: string) {
  return {
    ...page,
    logicalPath,
    normalizedPath: logicalPath.toLocaleLowerCase("en-US"),
    checksumSha256: createHash("sha256").update(page.bytes).digest("hex")
  };
}

function deltaError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document record delta error: ${code}`), { code });
}
