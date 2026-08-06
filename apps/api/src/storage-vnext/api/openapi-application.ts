import type { SourceResourceFileRecord } from "../../domain/source-resource.js";
import type { GeneratedFileKind } from "../../okf/publication-files.js";
import type { GeneratedFileSearchScope } from "../../search/generated-file-search-documents.js";
import type {
  GraphSearchDepth,
  GraphSearchMode
} from "../../search/graph-search-documents.js";

export type DeveloperOpenApiApplication = {
  createKnowledgeBase(input: { name: string; description: string | null }): Promise<Record<string, unknown>>;
  listKnowledgeBases(input: { limit: number; cursor: string | null }): Promise<Record<string, unknown>>;
  getKnowledgeBase(knowledgeBaseId: string): Promise<Record<string, unknown>>;
  getSourceFile(input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }): Promise<SourceResourceFileRecord | null>;
  readSourceContent(input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }): Promise<{
    content: BodyInit;
    contentType: string;
    resourceRevision: number;
    contentRevision: number;
  }>;
  listSourceFileEvents(input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
    cursor: string | null;
  }): Promise<Record<string, unknown>>;
  retrySourceFile(input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }): Promise<{ kind: string; scope: string; coalesced: boolean }>;
  listTree(input: {
    knowledgeBaseId: string;
    parentPath: string;
    entryType: "directory" | "file" | null;
    query: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<Record<string, unknown>>;
  searchFiles(input: {
    knowledgeBaseId: string;
    query: string;
    scope: GeneratedFileSearchScope;
    fileKind: GeneratedFileKind | null;
    mode: GraphSearchMode;
    graphDepth: GraphSearchDepth;
    graphFanout: number;
    limit: number;
    cursor: string | null;
  }): Promise<Record<string, unknown>>;
  getFileById(input: { knowledgeBaseId: string; fileId: string }): Promise<Record<string, unknown>>;
  listRelatedFiles(input: {
    knowledgeBaseId: string;
    fileId: string;
    limit: number;
    cursor: string | null;
  }): Promise<Record<string, unknown>>;
  expandGraph(input: {
    knowledgeBaseId: string;
    fileId: string | null;
    nodeId: string | null;
    edgeId: string | null;
    query: string | null;
    depth: GraphSearchDepth;
    fanout: number;
    limit: number;
    cursor: string | null;
  }): Promise<Record<string, unknown>>;
  getGraphOverview(input: { knowledgeBaseId: string }): Promise<Record<string, unknown>>;
  getFileContentById(input: {
    knowledgeBaseId: string;
    fileId: string;
  }): Promise<Record<string, unknown>>;
  getFileContentByPath(input: {
    knowledgeBaseId: string;
    path: string;
  }): Promise<Record<string, unknown>>;
  createWebhook(input: {
    name: string | null;
    url: string;
    events: string[];
  }): Promise<Record<string, unknown>>;
  listWebhooks(input: { limit: number; cursor: string | null }): Promise<Record<string, unknown>>;
  deleteWebhook(webhookId: string): Promise<Record<string, unknown>>;
  listWebhookDeliveries(input: { limit: number; cursor: string | null }): Promise<Record<string, unknown>>;
  redeliverWebhook(deliveryId: string): Promise<Record<string, unknown>>;
};

export function createDeveloperOpenApiService(input: {
  backend: DeveloperOpenApiApplication | null;
}): DeveloperOpenApiApplication {
  if (input.backend) return input.backend;
  const unavailable = async (): Promise<never> => {
    throw new Error("DATABASE_REPOSITORY_UNAVAILABLE");
  };
  return {
    createKnowledgeBase: unavailable,
    listKnowledgeBases: unavailable,
    getKnowledgeBase: unavailable,
    getSourceFile: unavailable,
    readSourceContent: unavailable,
    listSourceFileEvents: unavailable,
    retrySourceFile: unavailable,
    listTree: unavailable,
    searchFiles: unavailable,
    getFileById: unavailable,
    listRelatedFiles: unavailable,
    expandGraph: unavailable,
    getGraphOverview: unavailable,
    getFileContentById: unavailable,
    getFileContentByPath: unavailable,
    createWebhook: unavailable,
    listWebhooks: unavailable,
    deleteWebhook: unavailable,
    listWebhookDeliveries: unavailable,
    redeliverWebhook: unavailable
  };
}
