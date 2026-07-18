import type {
  OkfGraphRelationship,
  SourceMetadataDefaults,
  SourceModelSuggestions,
  OkfGraphNode
} from "@focowiki/okf";
import type { SerializableJson } from "./source-dispatch-repository.js";
import type { DirectoryStatistics } from "../../domain/tree-statistics.js";

export type PublicationSourceSnapshot = {
  sourceFileId: string;
  sourceRevisionId: string;
  resourceRevision: number;
  name: string;
  relativePath: string;
  generatedPath: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  metadata: SourceMetadataDefaults;
  suggestions: SourceModelSuggestions | null;
  graphNode: OkfGraphNode | null;
};

export type PublicationGraphEdgeSnapshot = {
  id: string;
  fromFileId: string;
  fromPath: string;
  fromTitle: string;
  toFileId: string;
  toPath: string;
  toTitle: string;
  relationType: string;
  weight: number;
  reason: string;
  source: string;
  evidence: Record<string, unknown>;
};

export type PublicationDirectorySnapshot = DirectoryStatistics & {
  id: string;
  sourceDirectoryId: string | null;
  name: string;
  relativePath: string;
  generatedPath: string;
  kind: "directory";
  resourceRevision: number;
};

export type PublicationKnowledgeBaseSnapshot = {
  id: string;
  name: string;
  description: string | null;
  sourceFileCount: number;
  graphEdgeCount: number;
};

export type PublicationNavigationTarget = {
  entryId: string;
  desiredEntry: {
    id: string;
    sortKey: string;
    name: string;
    targetPath: string;
    kind: "file" | "directory";
  } | null;
};

export type PublicationProjectionInput =
  | {
      kind: "source";
      document: PublicationSourceSnapshot;
      relationships: OkfGraphRelationship[];
    }
  | { kind: "graph_edge"; edge: PublicationGraphEdgeSnapshot }
  | { kind: "directory"; directory: PublicationDirectorySnapshot }
  | { kind: "navigation"; targets: PublicationNavigationTarget[] }
  | { kind: "knowledge_base"; descriptor: PublicationKnowledgeBaseSnapshot; rootEntryCount: number }
  | { kind: "empty" };

export function toProjectionInputJson(input: PublicationProjectionInput): SerializableJson {
  return JSON.parse(JSON.stringify(input)) as SerializableJson;
}
