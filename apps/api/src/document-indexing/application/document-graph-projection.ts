import { posix } from "node:path";
import {
  portableByFileGraphPath,
  portableDirectoryResourceSubject,
  portableGraphDirectoryPath,
  portableIndexDirectoryPath
} from "@focowiki/okf";
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
  machineProjectionError,
  removeStalePaths,
  type DirectoryState,
  type ProjectionRecord
} from "./document-machine-projection-shared.js";

export function buildDocumentGraphDirectoryScopeResources(input: {
  scopePath: string;
  records: readonly ProjectionRecord[];
  childDirectories: DirectoryState["childDirectories"];
  previousPaths: readonly string[];
  maximumRecordsPerShard: number;
  maximumShardBytes: number;
}) {
  const machineDirectory = portableGraphDirectoryPath(input.scopePath);
  const semanticSubject = portableDirectoryResourceSubject(input.scopePath);
  const packet = buildDocumentSemanticPacketPages({
    family: "relationship_packet",
    directoryPath: machineDirectory,
    subject: semanticSubject,
    title: directoryResourceTitle(input.scopePath, "relationships"),
    scopePath: input.scopePath,
    records: input.records,
    recordKey: documentGraphRelationshipKey,
    maximumRecords: input.maximumRecordsPerShard,
    maximumBytes: input.maximumShardBytes
  });
  return buildDocumentGraphDirectoryScopeResourcesFromPacket({
    scopePath: input.scopePath,
    packet,
    recordCount: input.records.length,
    childDirectories: input.childDirectories,
    previousPaths: input.previousPaths
  });
}

export function buildDocumentGraphDirectoryScopeResourcesFromPacket(input: {
  scopePath: string;
  packet: Readonly<{
    pages: readonly DocumentSemanticMachinePage[];
    descriptors: readonly DocumentSemanticPartDescriptor[];
  }>;
  recordCount: number;
  childDirectories: DirectoryState["childDirectories"];
  previousPaths: readonly string[];
}) {
  const machineDirectory = portableGraphDirectoryPath(input.scopePath);
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
  if (isEmptyDirectoryState(state)) {
    removedLogicalPaths.add(`${machineDirectory}/index.json`);
    return {
      pages: [],
      descriptors: [],
      removedLogicalPaths: [...removedLogicalPaths].sort(compareText)
    };
  }
  const router = jsonDocumentSemanticPage({
    logicalPath: `${machineDirectory}/index.json`,
    entryKind: "graph",
    family: "graph_directory",
    value: directoryRouterValue(state, "relationshipCount",
      portableGraphDirectoryPath)
  });
  return {
    pages: [...input.packet.pages, router],
    descriptors: input.packet.descriptors,
    removedLogicalPaths: [...removedLogicalPaths].sort(compareText)
  };
}

export function buildDocumentPerFileGraphScopeResource(input: {
  source: Readonly<{ path: string; title: string }> | null;
  relationships: readonly ProjectionRecord[];
  previousPaths: readonly string[];
}) {
  const currentPath = input.source
    ? portableByFileGraphPath(input.source.path)
    : null;
  const removedLogicalPaths = new Set(input.previousPaths.filter((path) =>
    path !== currentPath));
  if (!input.source || input.relationships.length === 0) {
    if (currentPath) removedLogicalPaths.add(currentPath);
    return {
      pages: [],
      removedLogicalPaths: [...removedLogicalPaths].sort(compareText)
    };
  }
  const pagePath = input.source.path;
  const page = jsonDocumentSemanticPage({
    logicalPath: currentPath!,
    entryKind: "related_files",
    family: "per_file_graph",
    value: {
      formatVersion: 2,
      title: `${input.source.title} relationships`,
      path: pagePath,
      indexPath: `${portableIndexDirectoryPath(posix.dirname(pagePath))}/index.json`,
      directoryGraphPath:
        `${portableGraphDirectoryPath(posix.dirname(pagePath))}/index.json`,
      relationships: [...input.relationships].sort(compareLocalRelationship)
    }
  });
  return {
    pages: [page],
    removedLogicalPaths: [...removedLogicalPaths].sort(compareText)
  };
}

export function buildDocumentGraphCatalogPage(relationshipCount: number) {
  if (!Number.isSafeInteger(relationshipCount) || relationshipCount < 0) {
    throw machineProjectionError("graph_catalog_count_invalid");
  }
  return jsonDocumentSemanticPage({
    logicalPath: "_graph/catalog.json",
    entryKind: "catalog",
    family: "graph_catalog",
    value: {
      formatVersion: 2,
      title: "Relationship graph",
      relationshipCount,
      resources: [...(relationshipCount > 0 ? [{
        kind: "directory_relationships",
        title: "Relationships by directory",
        path: "_graph/by-directory/index.json",
        description: "Directory routes to relationships among original documents."
      }, {
        kind: "file_relationships",
        title: "Relationships by file",
        path: "_graph/by-file/index.md",
        description: "Per-file relationship resources linked to original documents."
      }] : []), {
        kind: "page_descriptions",
        title: "Document descriptions",
        path: "_index/pages/index.json",
        description: "Document records that also describe graph nodes."
      }]
    }
  });
}

export function documentGraphRelationshipKey(
  record: Readonly<ProjectionRecord>
): string {
  return [record.from, record.to, record.relationType].map(asString).join("\0");
}

function compareLocalRelationship(
  left: Readonly<ProjectionRecord>,
  right: Readonly<ProjectionRecord>
): number {
  return compareText(asString(left.targetPath), asString(right.targetPath))
    || compareText(asString(left.direction), asString(right.direction))
    || compareText(asString(left.relationType), asString(right.relationType));
}
