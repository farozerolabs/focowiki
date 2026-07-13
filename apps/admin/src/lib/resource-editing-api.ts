import { adminFetch, type ApiFailure, type KnowledgeBase } from "@/lib/admin-api";

export type SourceDirectory = {
  directoryId: string;
  knowledgeBaseId: string;
  parentDirectoryId: string | null;
  name: string;
  relativePath: string;
  resourceRevision: number;
  directFileCount: number;
  descendantFileCount: number;
  mutable: boolean;
  deleting: boolean;
};

export type ResourceOperationState =
  | "accepted"
  | "validating"
  | "processing"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export type ResourceOperation = {
  operationId: string;
  knowledgeBaseId: string;
  kind: "source_file_move" | "source_directory_move" | "source_file_replace";
  state: ResourceOperationState;
  expectedResourceRevision: number | null;
  targetKind: "source_file" | "source_directory" | "knowledge_base" | null;
  targetId: string | null;
  candidateRelativePath: string | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  retryGuidance: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export async function updateKnowledgeBaseMetadata(input: {
  knowledgeBaseId: string;
  resourceRevision: number;
  name: string;
  description: string;
}): Promise<{ knowledgeBase: KnowledgeBase; publicationQueued: boolean } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": String(input.resourceRevision)
      },
      body: JSON.stringify({
        name: input.name.trim(),
        description: input.description.trim() || null
      })
    }
  );
  return readJsonResult(response, "errors.editKnowledgeBaseFailed");
}

export async function listSourceDirectories(input: {
  knowledgeBaseId: string;
  parentDirectoryId?: string | null;
  cursor?: string | null;
}): Promise<{ items: SourceDirectory[]; nextCursor: string | null } | ApiFailure> {
  const params = new URLSearchParams();
  if (input.parentDirectoryId) params.set("parentDirectoryId", input.parentDirectoryId);
  if (input.cursor) params.set("cursor", input.cursor);
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/source-directories${params.size ? `?${params}` : ""}`
  );
  return readJsonResult(response, "errors.loadDirectoriesFailed");
}

export async function fetchSourceDirectory(input: {
  knowledgeBaseId: string;
  sourceDirectoryId: string;
}): Promise<{ directory: SourceDirectory } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/source-directories/${encodeURIComponent(input.sourceDirectoryId)}`
  );
  return readJsonResult(response, "errors.loadDirectoriesFailed");
}

export async function moveSourceFile(input: {
  knowledgeBaseId: string;
  sourceFileId: string;
  resourceRevision: number;
  relativePath: string;
}): Promise<{ operation: ResourceOperation } | ApiFailure> {
  return acceptPathOperation({ ...input, resourceKind: "source-files", resourceId: input.sourceFileId });
}

export async function moveSourceDirectory(input: {
  knowledgeBaseId: string;
  sourceDirectoryId: string;
  resourceRevision: number;
  relativePath: string;
}): Promise<{ operation: ResourceOperation } | ApiFailure> {
  return acceptPathOperation({
    ...input,
    resourceKind: "source-directories",
    resourceId: input.sourceDirectoryId
  });
}

export async function readSourceFileContent(input: {
  knowledgeBaseId: string;
  sourceFileId: string;
}): Promise<{ content: string; contentRevision: number } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/source-files/${encodeURIComponent(input.sourceFileId)}/content`
  );
  if (!response.ok) return readFailureResponse(response, "errors.loadSourceContentFailed");
  return {
    content: await response.text(),
    contentRevision: Number(response.headers.get("x-content-revision") ?? 1)
  };
}

export async function replaceSourceFileContent(input: {
  knowledgeBaseId: string;
  sourceFileId: string;
  resourceRevision: number;
  content: string;
}): Promise<{ operation: ResourceOperation } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/source-files/${encodeURIComponent(input.sourceFileId)}/content`,
    {
      method: "PUT",
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "idempotency-key": crypto.randomUUID(),
        "if-match": String(input.resourceRevision)
      },
      body: input.content
    }
  );
  return readJsonResult(response, "errors.replaceSourceContentFailed");
}

export async function listActiveResourceOperations(input: {
  knowledgeBaseId: string;
}): Promise<{ items: ResourceOperation[]; nextCursor: string | null } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/operations?limit=100`
  );
  return readJsonResult(response, "errors.loadOperationsFailed");
}

async function acceptPathOperation(input: {
  knowledgeBaseId: string;
  resourceKind: "source-files" | "source-directories";
  resourceId: string;
  resourceRevision: number;
  relativePath: string;
}): Promise<{ operation: ResourceOperation } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/${input.resourceKind}/${encodeURIComponent(input.resourceId)}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "if-match": String(input.resourceRevision)
      },
      body: JSON.stringify({ relativePath: input.relativePath })
    }
  );
  return readJsonResult(response, "errors.resourceEditFailed");
}

async function readJsonResult<T>(response: Response, fallback: string): Promise<T | ApiFailure> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return readFailure(body, fallback);
  return body as T;
}

async function readFailureResponse(response: Response, fallback: string): Promise<ApiFailure> {
  return readFailure(await response.json().catch(() => ({})), fallback);
}

function readFailure(body: unknown, fallback: string): ApiFailure {
  const error = body && typeof body === "object"
    ? (body as { error?: { messageKey?: string } }).error
    : undefined;
  return { messageKey: error?.messageKey ?? fallback };
}
