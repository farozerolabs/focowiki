import {
  portableDirectoryResourceSubject,
  portableIndexDirectoryPath
} from "@focowiki/okf";
import {
  type DocumentTermBucket
} from "./document-term-routing.js";
import {
  buildDocumentSemanticPacketPages,
  jsonDocumentSemanticPage,
  type DocumentSemanticMachinePage,
  type DocumentSemanticPartDescriptor
} from "./document-semantic-resource-packets.js";
import {
  asString,
  compareText,
  directoryResourceTitle,
  directoryRouterValue,
  isEmptyDirectoryState,
  removeStalePaths,
  type DirectoryState,
  type ProjectionRecord
} from "./document-machine-projection-shared.js";

export function buildDocumentPageDirectoryScopeResources(input: {
  scopePath: string;
  records: readonly ProjectionRecord[];
  childDirectories: DirectoryState["childDirectories"];
  previousPaths: readonly string[];
  maximumRecordsPerShard: number;
  maximumShardBytes: number;
}) {
  const machineDirectory = portableIndexDirectoryPath(input.scopePath);
  const semanticSubject = portableDirectoryResourceSubject(input.scopePath);
  const packet = buildDocumentSemanticPacketPages({
    family: "document_packet",
    directoryPath: machineDirectory,
    subject: semanticSubject,
    title: directoryResourceTitle(input.scopePath, "documents"),
    scopePath: input.scopePath,
    records: input.records,
    recordKey: (record) => asString(record.path),
    maximumRecords: input.maximumRecordsPerShard,
    maximumBytes: input.maximumShardBytes
  });
  return buildDocumentPageDirectoryScopeResourcesFromPacket({
    scopePath: input.scopePath,
    packet,
    recordCount: input.records.length,
    childDirectories: input.childDirectories,
    previousPaths: input.previousPaths
  });
}

export function buildDocumentPageDirectoryScopeResourcesFromPacket(input: {
  scopePath: string;
  packet: Readonly<{
    pages: readonly DocumentSemanticMachinePage[];
    descriptors: readonly DocumentSemanticPartDescriptor[];
  }>;
  recordCount: number;
  childDirectories: DirectoryState["childDirectories"];
  previousPaths: readonly string[];
}) {
  const machineDirectory = portableIndexDirectoryPath(input.scopePath);
  const removedLogicalPaths = new Set<string>();
  removeStalePaths(input.previousPaths,
    input.packet.descriptors.map((descriptor) => descriptor.path),
    removedLogicalPaths);
  const state: DirectoryState = {
    scopePath: input.scopePath,
    childDirectories: [...input.childDirectories],
    resources: [...input.packet.descriptors],
    count: input.recordCount
  };
  if (input.scopePath !== "pages" && isEmptyDirectoryState(state)) {
    removedLogicalPaths.add(`${machineDirectory}/index.json`);
    return {
      pages: [],
      descriptors: [],
      removedLogicalPaths: [...removedLogicalPaths].sort(compareText)
    };
  }
  const router = jsonDocumentSemanticPage({
    logicalPath: `${machineDirectory}/index.json`,
    entryKind: "index",
    family: "page_directory",
    value: directoryRouterValue(state, "documentCount",
      portableIndexDirectoryPath)
  });
  return {
    pages: [...input.packet.pages, router],
    descriptors: input.packet.descriptors,
    removedLogicalPaths: [...removedLogicalPaths].sort(compareText)
  };
}

export function buildDocumentNavigationTermBucketResources(input: {
  bucket: DocumentTermBucket;
  records: readonly ProjectionRecord[];
  previousPaths: readonly string[];
  maximumRecordsPerShard: number;
  maximumShardBytes: number;
}) {
  const directoryPath = `_index/terms/${input.bucket}`;
  const builtPacket = buildDocumentSemanticPacketPages({
    family: "term_postings", directoryPath, subject: input.bucket,
    title: `${input.bucket} terms`, prefix: input.bucket,
    records: input.records,
    recordKey: (record) => asString(record.term),
    maximumRecords: input.maximumRecordsPerShard,
    maximumBytes: input.maximumShardBytes
  });
  const packet = assignFixedBucketPaths(builtPacket, input.bucket);
  const removedLogicalPaths = new Set<string>();
  removeStalePaths(input.previousPaths,
    packet.descriptors.map((item) => item.path), removedLogicalPaths);
  if (packet.descriptors.length === 0) {
    removedLogicalPaths.add(`${directoryPath}/index.json`);
    return {
      pages: [],
      descriptors: [],
      removedLogicalPaths: [...removedLogicalPaths].sort(compareText)
    };
  }
  const router = buildDocumentNavigationTermBucketRouterPage(
    input.bucket, packet.descriptors);
  return {
    pages: [...packet.pages, router],
    descriptors: packet.descriptors,
    removedLogicalPaths: [...removedLogicalPaths].sort(compareText)
  };
}

export function buildDocumentNavigationTermBucketRouterPage(
  bucket: DocumentTermBucket,
  descriptors: readonly Readonly<{
    path: string;
    firstKey: string;
    lastKey: string;
    recordCount: number;
  }>[]
) {
  return jsonDocumentSemanticPage({
    logicalPath: `_index/terms/${bucket}/index.json`, entryKind: "index",
    family: "term_bucket",
    value: {
      formatVersion: 2,
      title: `${bucket} term routes`,
      bucket,
      routes: descriptors.map((descriptor) => ({
        path: descriptor.path,
        firstTerm: descriptor.firstKey,
        lastTerm: descriptor.lastKey,
        recordCount: descriptor.recordCount
      }))
    }
  });
}

export function buildDocumentTermCatalogPage(
  buckets: readonly DocumentTermBucket[]
) {
  return jsonDocumentSemanticPage({
    logicalPath: "_index/terms/index.json", entryKind: "index",
    family: "term_catalog",
    value: {
      formatVersion: 2,
      title: "Term routes",
      normalization: {
        unicodeNormalization: "NFKC",
        caseFolding: "unicode",
        tokenization: "nodejieba-search-v1"
      },
      buckets: [...new Set(buckets)].sort(compareText).map((bucket) => ({
        bucket,
        path: `_index/terms/${bucket}/index.json`
      }))
    }
  });
}

export function buildDocumentIndexCatalogPage() {
  return jsonDocumentSemanticPage({
    logicalPath: "_index/catalog.json",
    entryKind: "catalog",
    family: "index_catalog",
    value: {
      formatVersion: 2,
      title: "Knowledge index",
      resources: [{
        kind: "page_directories",
        title: "Documents",
        path: "_index/pages/index.json",
        description: "Directory routes to original Markdown documents."
      }, {
        kind: "term_routes",
        title: "Terms",
        path: "_index/terms/index.json",
        description: "Multilingual term routes to original Markdown documents."
      }, {
        kind: "relationship_graph",
        title: "Relationships",
        path: "_graph/catalog.json",
        description: "Relationships among original Markdown documents."
      }]
    }
  });
}

function assignFixedBucketPaths(
  packet: ReturnType<typeof buildDocumentSemanticPacketPages>,
  bucket: DocumentTermBucket
) {
  const assigned = packet.pages.map((_, index) =>
    `_index/terms/${bucket}/${bucket}-terms-part-${String(index + 1)
      .padStart(4, "0")}.json`);
  const pages = packet.pages.map((page, index) => ({
    ...page,
    logicalPath: assigned[index]!,
    normalizedPath: assigned[index]!.toLocaleLowerCase("en-US")
  }));
  const descriptors = packet.descriptors.map((descriptor, index) => ({
    ...descriptor,
    path: assigned[index]!
  }));
  return { pages, descriptors };
}
