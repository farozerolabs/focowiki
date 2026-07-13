import type {
  OkfGraphRelationship,
  SourceMetadataDefaults,
  SourceModelSuggestions
} from "@focowiki/okf";

export type ReleasePublicationPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type ReleaseSourceFileRecord = {
  sourceFileId: string;
  sourceRevisionId: string;
  sourceDirectoryId: string | null;
  name: string;
  relativePath: string;
  generatedPath: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  metadata: SourceMetadataDefaults;
  suggestions: SourceModelSuggestions | null;
  publicationRequired: boolean;
};

export type ReleaseNavigationEntryRecord = {
  id: string;
  parentPath: string;
  kind: "directory_start" | "directory" | "file";
  name: string;
  targetPath: string;
  label: string;
  entryCount: number | null;
  directChildCount?: number | null;
  title?: string | null;
  description?: string | null;
  timestamp?: string | null;
  version?: string | null;
  duplicateTitleCount?: number;
  duplicateTimestampCount?: number;
  duplicateVersionCount?: number;
};

export type ReusableReleasePageRecord = {
  sourceFileId: string;
  logicalPath: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  okfType: string | null;
  title: string | null;
  description: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
};

export type ReleaseChangeAction = "created" | "updated" | "moved" | "deleted";

export type ReleaseChangeRecord = {
  sourceFileId: string;
  action: ReleaseChangeAction;
  previousPath: string | null;
  path: string | null;
  title: string;
};

export type ReleaseChangeSummary = {
  created: number;
  updated: number;
  moved: number;
  deleted: number;
  affectedDirectories: Array<{
    path: string;
    changedFileCount: number;
  }>;
};

export type ReleaseValidationIssue = {
  ruleId: string;
  path: string | null;
  message: string;
};

export type ReleaseValidationResult = {
  issues: ReleaseValidationIssue[];
  truncated: boolean;
};

export type ReleaseMarkdownLinkRecord = {
  sourceFileId: string | null;
  from: string;
  to: string;
  label: string;
  navigationOnly: boolean;
};

export type ReleaseMarkdownLinkIndexEntry = Pick<
  ReleaseMarkdownLinkRecord,
  "from" | "to" | "label"
>;

export type ReleasePublicationRepository = {
  materializeSourceSnapshot: (input: {
    knowledgeBaseId: string;
    releaseId: string;
    publicationSourceFileIds: string[];
  }) => Promise<{ directoryCount: number; sourceFileCount: number }>;
  countSourceFiles: (input: {
    knowledgeBaseId: string;
    releaseId: string;
  }) => Promise<number>;
  listSourceFiles: (input: {
    knowledgeBaseId: string;
    releaseId: string;
    cursor: string | null;
    limit: number;
  }) => Promise<ReleasePublicationPage<ReleaseSourceFileRecord>>;
  listNavigationEntries: (input: {
    knowledgeBaseId: string;
    releaseId: string;
    cursor: string | null;
    limit: number;
  }) => Promise<ReleasePublicationPage<ReleaseNavigationEntryRecord>>;
  listReusablePages: (input: {
    knowledgeBaseId: string;
    releaseId: string;
    candidateReleaseId: string;
    sourceFileIds: string[];
  }) => Promise<ReusableReleasePageRecord[]>;
  persistMarkdownLinks: (input: {
    knowledgeBaseId: string;
    releaseId: string;
    links: ReleaseMarkdownLinkRecord[];
  }) => Promise<void>;
  copyReusableMarkdownLinks: (input: {
    knowledgeBaseId: string;
    previousReleaseId: string;
    releaseId: string;
    sourceFileIds: string[];
  }) => Promise<void>;
  pruneInvalidSourceMarkdownLinks: (input: {
    knowledgeBaseId: string;
    releaseId: string;
    plannedTargetPaths: string[];
    batchSize: number;
  }) => Promise<number>;
  listValidMarkdownLinks: (input: {
    knowledgeBaseId: string;
    releaseId: string;
    cursor: string | null;
    limit: number;
    plannedTargetPaths: string[];
  }) => Promise<ReleasePublicationPage<ReleaseMarkdownLinkIndexEntry>>;
  summarizeChanges: (input: {
    knowledgeBaseId: string;
    previousReleaseId: string | null;
    releaseId: string;
    directoryLimit: number;
  }) => Promise<ReleaseChangeSummary>;
  listChanges: (input: {
    knowledgeBaseId: string;
    previousReleaseId: string | null;
    releaseId: string;
    cursor: string | null;
    limit: number;
  }) => Promise<ReleasePublicationPage<ReleaseChangeRecord>>;
  listSourceGraphNeighborhood: (input: {
    knowledgeBaseId: string;
    releaseId: string;
    sourceFileId: string;
    limit: number;
  }) => Promise<OkfGraphRelationship[]>;
  materializeTree: (input: {
    knowledgeBaseId: string;
    releaseId: string;
  }) => Promise<{ entryCount: number }>;
  validateRelease: (input: {
    knowledgeBaseId: string;
    releaseId: string;
    requireGraph: boolean;
    issueLimit: number;
  }) => Promise<ReleaseValidationResult>;
};
