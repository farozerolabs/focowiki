import type {
  OkfGraphEdge,
  OkfGraphNode,
  OkfGraphRelationship,
  SourceMetadataDefaults,
  SourceModelSuggestions
} from "@focowiki/okf";

export type PublicationSourceDocument = {
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

export type PublicationKnowledgeBaseDescriptor = {
  id: string;
  name: string;
  description: string | null;
  sourceFileCount: number;
  graphEdgeCount: number;
};

export type PublicationGraphEdge = OkfGraphEdge & {
  fromPath: string;
  fromTitle: string;
  toPath: string;
  toTitle: string;
};

export type PublicationDirectoryChild = {
  id: string;
  sourceDirectoryId: string | null;
  name: string;
  relativePath: string;
  generatedPath: string;
  kind: "file" | "directory";
  resourceRevision: number;
  childCount: number;
  directFileCount: number;
  descendantFileCount: number;
};

export type PublicationSourceRepository = {
  findDocument: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<PublicationSourceDocument | null>;
  findGraphEdge: (input: {
    knowledgeBaseId: string;
    edgeId: string;
  }) => Promise<PublicationGraphEdge | null>;
  listRelationships: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
  }) => Promise<OkfGraphRelationship[]>;
  findDirectoryChild: (input: {
    knowledgeBaseId: string;
    kind: "file" | "directory";
    relativePath: string;
    sourceFileId?: string | null;
  }) => Promise<PublicationDirectoryChild | null>;
  getKnowledgeBaseDescriptor: (
    knowledgeBaseId: string
  ) => Promise<PublicationKnowledgeBaseDescriptor | null>;
};
