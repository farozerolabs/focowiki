import { createHash } from "node:crypto";
import type { DocumentTermBucket } from "./document-term-routing.js";
import { buildDocumentNavigationTermBucketResources } from
  "./document-page-term-projection.js";
import type { DocumentSemanticMachinePage,
  DocumentSemanticPartDescriptor } from
  "./document-semantic-resource-packets.js";
import { partitionStableShardRuns, selectStableShardOwners } from
  "./document-stable-shard-runs.js";

export type DocumentTermBaseRouter = Readonly<{
  resources: readonly DocumentSemanticPartDescriptor[];
}>;

export async function applyDocumentTermStableShardDelta(input: Readonly<{
  bucket: DocumentTermBucket;
  base: DocumentTermBaseRouter;
  changedRecords: readonly Record<string, unknown>[];
  removedTerms: readonly string[];
  maximumRecords: number;
  maximumBytes: number;
  readRecords(path: string): Promise<readonly Record<string, unknown>[]>;
  checkpoint?(): Promise<void>;
}>) {
  const changes = new Map(input.changedRecords.map((record) => [
    termKey(record), record
  ]));
  const changedKeys = [...new Set([
    ...changes.keys(), ...input.removedTerms
  ])].sort(compareText);
  if (changedKeys.length === 0) {
    return {
      pages: [] as DocumentSemanticMachinePage[],
      descriptors: input.base.resources,
      removedPaths: [] as string[]
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
      input.base.resources, key, true).some((owner) =>
        runPaths.has(owner.path)) || input.base.resources.length === 0);
    const records = new Map<string, Record<string, unknown>>();
    for (const descriptor of run) {
      for (const record of await input.readRecords(descriptor.path)) {
        mergeTermRecord(records, record);
      }
      await input.checkpoint?.();
    }
    runKeys.filter((key) => input.removedTerms.includes(key))
      .forEach((key) => records.delete(key));
    runKeys.forEach((key) => {
      const record = changes.get(key);
      if (record) records.set(key, record);
    });
    const rebuilt = buildDocumentNavigationTermBucketResources({
      bucket: input.bucket, records: [...records.values()], previousPaths: [],
      maximumRecordsPerShard: input.maximumRecords,
      maximumShardBytes: input.maximumBytes
    });
    const packetPages = rebuilt.pages.filter((page) =>
      page.logicalPath !== `_index/terms/${input.bucket}/index.json`);
    const paths = allocateStablePaths({
      bucket: input.bucket, existing: input.base.resources, touched: run,
      count: packetPages.length, usedPaths
    });
    const runPages = packetPages.map((page, index) =>
      withPath(page, paths[index]!));
    pages.push(...runPages);
    updated.push(...rebuilt.descriptors.map((descriptor, index) => ({
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
    removedPaths: removedPaths.sort(compareText)
  };
}

function mergeTermRecord(
  records: Map<string, Record<string, unknown>>,
  record: Readonly<Record<string, unknown>>
): void {
  const term = termKey(record);
  const postings = Array.isArray(record.postings) ? record.postings : [];
  const existing = records.get(term);
  records.set(term, existing ? {
    term,
    postings: [...(Array.isArray(existing.postings)
      ? existing.postings : []), ...postings]
  } : { ...record, postings });
}

function termKey(record: Readonly<Record<string, unknown>>): string {
  if (typeof record.term !== "string" || record.term.length === 0) {
    throw termDeltaError("term_delta_record_invalid");
  }
  return record.term;
}

function selectTouchedDescriptors(
  descriptors: readonly DocumentSemanticPartDescriptor[],
  keys: readonly string[]
): DocumentSemanticPartDescriptor[] {
  if (descriptors.length === 0) return [];
  const selected = new Set<DocumentSemanticPartDescriptor>();
  for (const key of keys) {
    selectStableShardOwners(descriptors, key, true)
      .forEach((descriptor) => selected.add(descriptor));
  }
  return [...selected].sort((left, right) =>
    compareText(left.firstKey, right.firstKey)
      || compareText(left.path, right.path));
}

function allocateStablePaths(input: Readonly<{
  bucket: DocumentTermBucket;
  existing: readonly DocumentSemanticPartDescriptor[];
  touched: readonly DocumentSemanticPartDescriptor[];
  count: number;
  usedPaths: Set<string>;
}>): string[] {
  const paths = input.touched.slice(0, input.count)
    .map((descriptor) => descriptor.path);
  let nextPart = Math.max(0, ...input.existing.map((descriptor) =>
    partNumber(descriptor.path))) + 1;
  while (paths.length < input.count) {
    const path = `_index/terms/${input.bucket}/${input.bucket}-terms-part-${
      String(nextPart).padStart(4, "0")}.json`;
    nextPart += 1;
    if (input.usedPaths.has(path)) continue;
    paths.push(path);
    input.usedPaths.add(path);
  }
  return paths;
}

function partNumber(path: string): number {
  const match = path.match(/-part-(\d+)\.json$/u);
  return match ? Number(match[1]) : 0;
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

function termDeltaError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document term delta error: ${code}`), { code });
}
