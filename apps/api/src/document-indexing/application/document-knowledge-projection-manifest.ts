import type { DocumentDirectoryNavigationMutation } from
  "./document-directory-navigation-mutation.js";
import type { StagedDocumentPage } from
  "./document-generated-page-staging.js";
type ScopedActivationOwnerKind =
  | "source" | "relation_pair" | "directory_leaf" | "directory_entry"
  | "search_family" | "page_head";
type ProjectionDirtyScopeKind =
  | "source" | "relation" | "directory" | "graph"
  | "_index" | "_graph" | "root";

export type DocumentKnowledgeProjectionManifest = {
  schemaVersion: "document-knowledge-projection-manifest-v1";
  knowledgeBaseId: string;
  documentJobPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  readinessSequence: number;
  presentation: {
    logicalPath: string;
    normalizedPath: string;
    title: string;
    metadata: Readonly<Record<string, unknown>>;
    modelSuggestions: Readonly<Record<string, unknown>> | null;
  };
  affectedSourceFilePublicIds: readonly string[];
  relationPublicIds: readonly string[];
  searchFamilyPublicIds: readonly string[];
  relationshipSearchDocumentPublicIds: readonly string[];
  pageCandidates: readonly StagedDocumentPage[];
  removedPageNormalizedPaths: readonly string[];
  navigationMutations: readonly DocumentDirectoryNavigationMutation[];
  dirtyScopes: ReadonlyArray<{
    kind: ProjectionDirtyScopeKind;
    key: string;
  }>;
  activationOwners: ReadonlyArray<{
    kind: ScopedActivationOwnerKind;
    key: string;
    expectedVersion: number;
    activeSourceRevisionPublicId: string | null;
    activePageCandidatePublicId: string | null;
  }>;
  projectedAt: string;
};

export type DocumentKnowledgeProjectionManifestPointer = {
  objectId: string;
  storageKey: string;
  checksumSha256: string;
  byteCount: number;
  contentType: "application/json; charset=utf-8";
  objectFormat: "okf-generated-json-v1";
};
