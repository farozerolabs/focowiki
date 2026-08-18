import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { posix } from "node:path";
import {
  buildDocumentNavigationTermBucketResources,
  buildDocumentPageDirectoryScopeResources
} from "../../apps/api/src/document-indexing/application/document-page-term-projection.js";
import {
  documentProjectionNavigationTerms,
  documentSourceProjectionRecord
} from "../../apps/api/src/document-indexing/application/document-machine-record.js";
import {
  DOCUMENT_TERM_BUCKETS,
  classifyDocumentNavigationTerm,
  type DocumentTermBucket
} from "../../apps/api/src/document-indexing/application/document-term-routing.js";
import { createNodeJiebaTokenizer } from
  "../../apps/api/src/infrastructure/tokenization/nodejieba-tokenizer.js";
import {
  buildDocumentSemanticPacketPages,
  jsonDocumentSemanticPage,
  type DocumentSemanticPartDescriptor
} from "../../apps/api/src/document-indexing/application/document-semantic-resource-packets.js";

const FILE_COUNT = 20_000;
const DIRECTORY_COUNT = 200;
const MAXIMUM_RECORDS = 250;
const MAXIMUM_BYTES = 262_144;
const decoder = new TextDecoder();
const tokenizer = createNodeJiebaTokenizer();

const rssBefore = process.memoryUsage().rss;
const cpuBefore = process.cpuUsage();
const coldStarted = performance.now();
const first = buildCorpus(false);
const coldGenerationMs = performance.now() - coldStarted;
const rssAfterCold = process.memoryUsage().rss;
const coldCpu = process.cpuUsage(cpuBefore);

const warmStarted = performance.now();
for (let index = 0; index < 5_000; index += 1) {
  const ordinal = (index * 7_919) % FILE_COUNT;
  const expectedPath = pagePath(ordinal);
  assert.equal(findDocument(first.objects, expectedPath)?.path, expectedPath);
}
const warmLookupMs = performance.now() - warmStarted;

const editSource = source(10_125, "Updated portable document");
const editStarted = performance.now();
const editRecord = sourceRecord(editSource);
const directoryRecords = first.documentsByDirectory.get(
  posix.dirname(String(editRecord.path)))!.map((record) =>
    record.path === editRecord.path ? editRecord : record);
const editPages = buildDocumentPageDirectoryScopeResources({
  scopePath: posix.dirname(String(editRecord.path)),
  records: directoryRecords,
  childDirectories: [],
  previousPaths: pathsWithin(first.objects,
    `_index/pages/${directory(10_125)}`),
  maximumRecordsPerShard: MAXIMUM_RECORDS,
  maximumShardBytes: MAXIMUM_BYTES
});
const priorRecord = first.sourceRecordsByPath.get(String(editRecord.path))!;
const affectedBuckets = new Set([
  ...documentProjectionNavigationTerms(priorRecord),
  ...documentProjectionNavigationTerms(editRecord)
].map((term) => classifyDocumentNavigationTerm(term.term)));
const termPages = [...affectedBuckets].flatMap((bucket) => {
  const records = replaceTermPostings({
    bucket,
    records: first.termRecordsByBucket.get(bucket) ?? [],
    pagePath: String(editRecord.path),
    selected: documentProjectionNavigationTerms(editRecord)
  });
  return buildDocumentNavigationTermBucketResources({
    bucket,
    records,
    previousPaths: pathsWithin(first.objects, `_index/terms/${bucket}`),
    maximumRecordsPerShard: MAXIMUM_RECORDS,
    maximumShardBytes: MAXIMUM_BYTES
  });
});
const editGenerationMs = performance.now() - editStarted;
const projectedPages = [editPages, ...termPages];
const changedWrites = projectedPages.flatMap((projection) => projection.pages)
  .filter((page) => !bytesEqual(first.objects.get(page.logicalPath), page.bytes))
  .length + projectedPages.flatMap((projection) =>
    projection.removedLogicalPaths).length;
assert(changedWrites <= 32, `Unexpected edit write amplification: ${changedWrites}`);

const reproductionStarted = performance.now();
const second = buildCorpus(true);
const reproductionMs = performance.now() - reproductionStarted;
assert.equal(second.fingerprint, first.fingerprint);
assert.equal(second.objectCount, first.objectCount);

const report = {
  kind: "portable-bundle-v2-synthetic-benchmark",
  fileCount: FILE_COUNT,
  directoryCount: DIRECTORY_COUNT,
  externalModelCalls: 0,
  limits: { maximumRecords: MAXIMUM_RECORDS, maximumBytes: MAXIMUM_BYTES },
  cold: {
    generationMs: round(coldGenerationMs),
    cpuUserMs: round(coldCpu.user / 1_000),
    cpuSystemMs: round(coldCpu.system / 1_000),
    rssDeltaMiB: round((rssAfterCold - rssBefore) / 1_048_576),
    objectWrites: first.objectCount,
    byteCount: first.byteCount
  },
  warmLookup: {
    operations: 5_000,
    elapsedMs: round(warmLookupMs),
    meanMs: round(warmLookupMs / 5_000)
  },
  singleFileEdit: {
    elapsedMs: round(editGenerationMs),
    generatedObjectReads: 0,
    renderedObjects: projectedPages.reduce((total, projection) =>
      total + projection.pages.length, 0),
    objectWrites: changedWrites,
    removedObjects: projectedPages.reduce((total, projection) =>
      total + projection.removedLogicalPaths.length, 0)
  },
  reproducibility: {
    reverseInputElapsedMs: round(reproductionMs),
    fingerprint: first.fingerprint,
    identicalPathsAndBytes: true
  },
  scope: "Synthetic projection evidence only; no production throughput extrapolation."
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function buildCorpus(reverse: boolean) {
  const objects = new Map<string, Uint8Array>();
  const ordinals = Array.from({ length: FILE_COUNT }, (_, index) => index);
  if (reverse) ordinals.reverse();
  const documentsByDirectory = new Map<string, Record<string, unknown>[]>();
  const sourceRecordsByPath = new Map<string, Record<string, unknown>>();
  const relationshipsByDirectory = new Map<string, Record<string, unknown>[]>();
  const postingsByTerm = new Map<string, Record<string, unknown>[]>();

  for (const ordinal of ordinals) {
    const current = source(ordinal, title(ordinal));
    const record = sourceRecord(current);
    sourceRecordsByPath.set(String(record.path), record);
    const scope = posix.dirname(String(record.path));
    append(documentsByDirectory, scope, record);
    for (const selected of documentProjectionNavigationTerms(record)) {
      append(postingsByTerm, selected.term, {
        path: record.path,
        fields: selected.fields
      });
    }
    const next = ordinal + 1 < FILE_COUNT && directory(ordinal + 1) === directory(ordinal)
      ? ordinal + 1 : null;
    if (next !== null) {
      append(relationshipsByDirectory, scope, {
        from: pagePath(ordinal),
        to: pagePath(next),
        fromTitle: title(ordinal),
        toTitle: title(next),
        direction: "outgoing",
        relationType: "references",
        weight: 1,
        reason: `${title(ordinal)} explicitly references ${title(next)}.`,
        evidence: [{ path: pagePath(ordinal) }]
      });
    }
  }

  for (const [scope, records] of [...documentsByDirectory].sort()) {
    const directoryPath = scope.replace(/^pages/u, "_index/pages");
    const packet = buildDocumentSemanticPacketPages({
      family: "document_packet", directoryPath,
      subject: posix.basename(scope) === "pages" ? "all" : posix.basename(scope),
      title: `${posix.basename(scope)} documents`, scopePath: scope, records,
      recordKey: (record) => String(record.path),
      maximumRecords: MAXIMUM_RECORDS, maximumBytes: MAXIMUM_BYTES
    });
    storePages(objects, packet.pages);
    storeDirectoryRouter(objects, scope, directoryPath, packet.descriptors,
      records.length, "documentCount");
  }

  const termsByBucket = new Map<string, Record<string, unknown>[]>();
  for (const [term, postings] of [...postingsByTerm].sort()) {
    postings.sort((left, right) => compareText(String(left.path), String(right.path)));
    append(termsByBucket, classifyDocumentNavigationTerm(term), { term, postings });
  }
  const termBuckets: Record<string, unknown>[] = [];
  for (const bucket of DOCUMENT_TERM_BUCKETS) {
    const records = termsByBucket.get(bucket) ?? [];
    if (records.length === 0) continue;
    const termRoutes: Record<string, unknown>[] = [];
    const directoryPath = `_index/terms/${bucket}`;
    const packet = buildDocumentSemanticPacketPages({
      family: "term_postings", directoryPath, subject: bucket,
      title: `${bucket} terms`, prefix: bucket, records,
      recordKey: (record) => String(record.term),
      maximumRecords: MAXIMUM_RECORDS, maximumBytes: MAXIMUM_BYTES
    });
    const pages = packet.pages.map((page, index) => ({
      ...page,
      logicalPath: `_index/terms/${bucket}/${bucket}-terms-part-${String(index + 1)
        .padStart(4, "0")}.json`
    }));
    storePages(objects, pages);
    for (const [index, descriptor] of packet.descriptors.entries()) {
      const page = pages[index]!;
      const terms = JSON.parse(decoder.decode(page.bytes)).terms as Array<{
        postings: unknown[]
      }>;
      termRoutes.push({ path: page.logicalPath,
        firstTerm: descriptor.firstKey, lastTerm: descriptor.lastKey,
        recordCount: terms.length });
    }
    store(objects, jsonDocumentSemanticPage({
      logicalPath: `${directoryPath}/index.json`, entryKind: "index",
      family: "term_bucket", value: {
        formatVersion: 2, title: `${bucket} term routes`, bucket,
        routes: termRoutes.splice(0)
      }
    }));
    termBuckets.push({ bucket, path: `${directoryPath}/index.json` });
  }
  store(objects, jsonDocumentSemanticPage({
    logicalPath: "_index/terms/index.json", entryKind: "index", family: "term_catalog",
    value: { formatVersion: 2, title: "Term routes",
      normalization: { unicodeNormalization: "NFKC", caseFolding: "unicode",
        tokenization: "nodejieba-search-v1" },
      buckets: termBuckets.sort((left, right) => compareText(
        String(left.bucket), String(right.bucket))) }
  }));

  for (const [scope, records] of [...relationshipsByDirectory].sort()) {
    const directoryPath = scope.replace(/^pages/u, "_graph/by-directory");
    const packet = buildDocumentSemanticPacketPages({
      family: "relationship_packet", directoryPath,
      subject: posix.basename(scope) === "pages" ? "all" : posix.basename(scope),
      title: `${posix.basename(scope)} relationships`, scopePath: scope, records,
      recordKey: (record) => `${record.from}\0${record.to}\0${record.relationType}`,
      maximumRecords: MAXIMUM_RECORDS, maximumBytes: MAXIMUM_BYTES
    });
    storePages(objects, packet.pages);
    storeDirectoryRouter(objects, scope, directoryPath, packet.descriptors,
      records.length, "relationshipCount");
  }
  for (let ordinal = 0; ordinal < FILE_COUNT; ordinal += 1) {
    const path = pagePath(ordinal);
    const next = ordinal + 1 < FILE_COUNT && directory(ordinal + 1) === directory(ordinal)
      ? ordinal + 1 : null;
    store(objects, jsonDocumentSemanticPage({
      logicalPath: `_graph/by-file/${path.slice("pages/".length, -3)}.json`,
      entryKind: "related_files", family: "per_file_graph",
      value: { formatVersion: 2, title: `${title(ordinal)} relationships`, path,
        indexPath: `_index/pages/${directory(ordinal)}/index.json`,
        directoryGraphPath: `_graph/by-directory/${directory(ordinal)}/index.json`,
      relationships: [
        ...(ordinal > 0 && directory(ordinal - 1) === directory(ordinal)
          ? [{ targetPath: pagePath(ordinal - 1), targetTitle: title(ordinal - 1),
              direction: "incoming", relationType: "references", weight: 1,
              reason: `${title(ordinal - 1)} explicitly references ${title(ordinal)}.`,
              evidence: [{ path: pagePath(ordinal - 1) }] }] : []),
        ...(next === null ? [] : [{ targetPath: pagePath(next),
          targetTitle: title(next), direction: "outgoing", relationType: "references",
          weight: 1, reason: `${title(ordinal)} explicitly references ${title(next)}.`,
          evidence: [{ path }] }])
      ] }
    }));
  }
  const ordered = [...objects].sort(([left], [right]) => compareText(left, right));
  const fingerprint = createHash("sha256");
  let byteCount = 0;
  for (const [path, bytes] of ordered) {
    fingerprint.update(path).update("\0").update(bytes);
    byteCount += bytes.byteLength;
  }
  return { objects, documentsByDirectory, sourceRecordsByPath,
    termRecordsByBucket: termsByBucket, objectCount: objects.size, byteCount,
    fingerprint: fingerprint.digest("hex") };
}

function sourceRecord(current: ReturnType<typeof source>) {
  return documentSourceProjectionRecord({
    path: current.logicalPath,
    title: current.title,
    body: current.body,
    contentType: current.contentType,
    checksumSha256: current.checksumSha256,
    byteCount: current.byteCount,
    metadata: current.sourceMetadata,
    entities: []
  }, tokenizer, { hasRelationships: true });
}

function replaceTermPostings(input: {
  bucket: DocumentTermBucket;
  records: readonly Record<string, unknown>[];
  pagePath: string;
  selected: ReturnType<typeof documentProjectionNavigationTerms>;
}): Record<string, unknown>[] {
  const records = new Map(input.records.map((record) => [
    String(record.term),
    (Array.isArray(record.postings) ? record.postings : [])
      .filter((posting) => String((posting as { path?: unknown }).path)
        !== input.pagePath)
      .map((posting) => ({ ...(posting as Record<string, unknown>) }))
  ]));
  for (const selected of input.selected) {
    if (classifyDocumentNavigationTerm(selected.term) !== input.bucket) continue;
    const postings = records.get(selected.term) ?? [];
    postings.push({ path: input.pagePath, fields: selected.fields });
    records.set(selected.term, postings);
  }
  return [...records].filter(([, postings]) => postings.length > 0)
    .sort(([left], [right]) => compareText(left, right))
    .map(([term, postings]) => ({
      term,
      postings: postings.sort((left, right) => compareText(
        String(left.path), String(right.path)))
    }));
}

function pathsWithin(
  objects: ReadonlyMap<string, Uint8Array>,
  directoryPath: string
): string[] {
  return [...objects.keys()].filter((path) =>
    posix.dirname(path) === directoryPath && path.endsWith(".json")
    && posix.basename(path) !== "index.json").sort(compareText);
}

function storeDirectoryRouter(
  objects: Map<string, Uint8Array>,
  scopePath: string,
  machineDirectory: string,
  resources: readonly DocumentSemanticPartDescriptor[],
  count: number,
  countKey: "documentCount" | "relationshipCount"
): void {
  store(objects, jsonDocumentSemanticPage({
    logicalPath: `${machineDirectory}/index.json`,
    entryKind: countKey === "documentCount" ? "index" : "graph",
    family: countKey === "documentCount" ? "page_directory" : "graph_directory",
    value: { formatVersion: 2,
      title: `${posix.basename(scopePath)} ${countKey === "documentCount"
        ? "documents" : "relationships"}`,
      scopePath, parentPath: countKey === "documentCount"
        ? "_index/pages/index.json" : "_graph/by-directory/index.json",
      childDirectories: [], resources, [countKey]: count }
  }));
}

function findDocument(objects: ReadonlyMap<string, Uint8Array>, path: string) {
  const routerPath = `${posix.dirname(path).replace(/^pages/u, "_index/pages")}/index.json`;
  const router = JSON.parse(decoder.decode(objects.get(routerPath)!));
  const resource = router.resources.find((item: DocumentSemanticPartDescriptor) =>
    item.firstKey <= path && path <= item.lastKey);
  const packet = JSON.parse(decoder.decode(objects.get(resource.path)!));
  return packet.documents.find((item: { path: string }) => item.path === path);
}

function source(ordinal: number, sourceTitle: string) {
  const body = [
    `# ${sourceTitle}`,
    "",
    `## 缓存恢复与租约一致性 ${ordinal}`,
    "增量投影必须避免全库扫描、重复对象写入和过期租约覆盖。",
    `The portable agent route ${ordinal} preserves exact paths and bounded discovery terms.`,
    `検索復旧${ordinal} は固定ルーターから原文へ移動します。`,
    `검색복구${ordinal} 경로는 원문과 관계 근거를 유지합니다.`,
    `entity-${ordinal} topic-${ordinal} revision-${ordinal}`
  ].join("\n");
  return {
    sourceFilePublicId: `benchmark-source-${ordinal}`,
    sourceRevisionPublicId: `benchmark-revision-${ordinal}`,
    resourceRevision: 1,
    logicalPath: `${directory(ordinal)}/document-${String(ordinal).padStart(5, "0")}.md`,
    title: sourceTitle,
    body,
    metadata: { type: "document", title: sourceTitle },
    sourceMetadata: {
      title: sourceTitle,
      aliases: [`便携文档 ${ordinal}`],
      tags: ["portable", "增量投影", `topic-${ordinal % 997}`],
      subjects: ["distributed systems", "knowledge navigation"]
    },
    checksumSha256: createHash("sha256").update(body).digest("hex"),
    byteCount: Buffer.byteLength(body),
    contentType: "text/markdown; charset=utf-8",
    semanticEntities: []
  };
}

function directory(ordinal: number): string {
  return `library-${String(Math.floor(ordinal / (FILE_COUNT / DIRECTORY_COUNT)))
    .padStart(3, "0")}`;
}

function pagePath(ordinal: number): string {
  return `pages/${directory(ordinal)}/document-${String(ordinal).padStart(5, "0")}.md`;
}

function title(ordinal: number): string {
  return `Portable Document ${String(ordinal).padStart(5, "0")}`;
}

function append(map: Map<string, Record<string, unknown>[]>, key: string,
  value: Record<string, unknown>): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function storePages(objects: Map<string, Uint8Array>, pages: readonly {
  logicalPath: string; bytes: Uint8Array
}[]): void {
  for (const page of pages) objects.set(page.logicalPath, page.bytes);
}

function store(objects: Map<string, Uint8Array>, page: {
  logicalPath: string; bytes: Uint8Array
}): void {
  objects.set(page.logicalPath, page.bytes);
}

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return left?.byteLength === right.byteLength && left.every((byte, index) =>
    byte === right[index]);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
