export type KnowledgeBase = {
  id: string;
  name: string;
  description: string | null;
  activeReleaseId: string | null;
};

export type KnowledgeBasePage = {
  items: KnowledgeBase[];
  nextCursor: string | null;
};

export type PublicOpenApiKey = {
  id: string;
  name: string;
  fingerprint: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
};

export type OneTimePublicOpenApiKey = {
  id: string;
  rawKey: string;
};

export type PublicOpenApiKeyPage = {
  items: PublicOpenApiKey[];
  nextCursor: string | null;
  oneTimeKey: OneTimePublicOpenApiKey | null;
};

export type UploadTaskLifecycle = {
  id: string;
  operation?: "upload" | "delete_source" | "delete_knowledge_base";
  startedAt: string;
  endedAt: string | null;
  lifecycle: "running" | "ended";
  sourceCount?: number;
  progress?: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
  };
};

export type BundleTreeEntry = {
  id: string;
  name: string;
  logicalPath: string;
  entryType: "directory" | "file";
  bundleFileId: string | null;
  sourceFileId?: string | null;
  fileKind?: "page" | "index" | "schema" | "manifest_index" | "search_index" | "link_index" | null;
  deletable?: boolean;
};

export type BundleTreePage = {
  items: BundleTreeEntry[];
  nextCursor: string | null;
};

export type BundleFileDetail = {
  file: {
    id: string;
    sourceFileId: string | null;
    fileKind: "page" | "index" | "schema" | "manifest_index" | "search_index" | "link_index";
    logicalPath: string;
    contentType: string;
    title: string | null;
    deletable: boolean;
  };
  content: string;
  readOnly: true;
};

export type SourceFileRecord = {
  id: string;
  taskId?: string;
  originalName: string;
  processingStatus?: "pending" | "running" | "completed" | "failed";
  processingStage?:
    | "upload_storage"
    | "metadata_resolution"
    | "okf_validation"
    | "bundle_generation"
    | "index_publication"
    | "release_activation";
  processingStartedAt?: string | null;
  processingEndedAt?: string | null;
  processingErrorCode?: string | null;
  createdAt: string;
};

export type ReleaseRecord = {
  id: string;
  fileCount: number;
  generatedAt: string;
  publishedAt: string | null;
};

export type BundleFileRecord = {
  id: string;
  logicalPath: string;
  contentType: string;
  title: string | null;
};

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type UploadTaskPage = {
  items: UploadTaskLifecycle[];
  nextCursor: string | null;
};

export type UploadTaskPhaseDetail = {
  id: string;
  taskId: string;
  phaseKey: string;
  messageKey: string;
  startedAt: string | null;
  endedAt: string | null;
  severity: "info" | "warning" | "error";
  createdAt: string;
};

export type UploadTaskDetail = {
  task: UploadTaskLifecycle;
  phaseDetails: {
    items: UploadTaskPhaseDetail[];
    nextCursor: string | null;
  };
  sourceFiles: {
    items: SourceFileRecord[];
    nextCursor: string | null;
  };
};

export type KnowledgeBasePublicUrls = {
  index: string;
  search: string;
  links: string;
};

export type ApiFailure = {
  messageKey: string;
};

type AuthFailureHandler = () => void;

let authFailureHandler: AuthFailureHandler | null = null;

export function setAdminAuthFailureHandler(handler: AuthFailureHandler | null) {
  authFailureHandler = handler;
}

export async function checkAdminSession(): Promise<boolean> {
  try {
    const response = await adminFetch("/admin/api/session");

    return response.ok;
  } catch {
    return false;
  }
}

export async function loginAdmin(input: { username: string; password: string }): Promise<boolean> {
  const response = await fetch(adminApiUrl("/admin/api/login"), {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });

  return response.ok;
}

export async function logoutAdmin(): Promise<void> {
  await adminFetch("/admin/api/logout", {
    method: "POST"
  });
}

export async function listKnowledgeBases(input: {
  cursor?: string | null;
  limit?: number;
}): Promise<KnowledgeBasePage> {
  const params = new URLSearchParams();

  if (input.limit) {
    params.set("limit", String(input.limit));
  }
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }

  const response = await adminFetch(`/admin/api/knowledge-bases${params.size ? `?${params}` : ""}`);

  if (!response.ok) {
    return {
      items: [],
      nextCursor: null
    };
  }

  return (await response.json()) as KnowledgeBasePage;
}

export async function createKnowledgeBase(input: {
  name: string;
  description: string;
}): Promise<{ knowledgeBase: KnowledgeBase } | ApiFailure> {
  const response = await adminFetch("/admin/api/knowledge-bases", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name: input.name,
      ...(input.description.trim() ? { description: input.description.trim() } : {})
    })
  });
  const body = (await response.json()) as
    | { knowledgeBase: KnowledgeBase }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.invalidKnowledgeBase");
  }

  return body as { knowledgeBase: KnowledgeBase };
}

export async function deleteKnowledgeBase(input: {
  knowledgeBaseId: string;
}): Promise<{ deleted: true } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}`,
    {
      method: "DELETE"
    }
  );
  const body = (await response.json()) as
    | { deleted: true }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.deleteFailed");
  }

  return body as { deleted: true };
}

export async function listPublicOpenApiKeys(input: {
  cursor?: string | null;
  limit?: number;
}): Promise<PublicOpenApiKeyPage> {
  const params = new URLSearchParams();

  if (input.limit) {
    params.set("limit", String(input.limit));
  }
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }

  const response = await adminFetch(`/admin/api/openapi-keys${params.size ? `?${params}` : ""}`);

  if (!response.ok) {
    return {
      items: [],
      nextCursor: null,
      oneTimeKey: null
    };
  }

  return (await response.json()) as PublicOpenApiKeyPage;
}

export async function createPublicOpenApiKey(input: {
  name: string;
}): Promise<{ key: PublicOpenApiKey; oneTimeKey: OneTimePublicOpenApiKey } | ApiFailure> {
  const response = await adminFetch("/admin/api/openapi-keys", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input.name.trim() ? { name: input.name.trim() } : {})
  });
  const body = (await response.json()) as
    | { key: PublicOpenApiKey; oneTimeKey: OneTimePublicOpenApiKey }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.openapiKeyFailed");
  }

  return body as { key: PublicOpenApiKey; oneTimeKey: OneTimePublicOpenApiKey };
}

export async function deletePublicOpenApiKey(input: {
  keyId: string;
}): Promise<{ deleted: true } | ApiFailure> {
  const response = await adminFetch(`/admin/api/openapi-keys/${encodeURIComponent(input.keyId)}`, {
    method: "DELETE"
  });
  const body = (await response.json()) as
    | { deleted: true }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.deleteFailed");
  }

  return body as { deleted: true };
}

export async function uploadKnowledgeBaseSources(input: {
  knowledgeBaseId: string;
  files: File[];
}): Promise<{ task: UploadTaskLifecycle } | ApiFailure> {
  const formData = new FormData();

  input.files.forEach((file) => {
    formData.append("files", file);
  });

  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/uploads`,
    {
      method: "POST",
      body: formData
    }
  );
  const body = (await response.json()) as
    | { task: UploadTaskLifecycle }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.invalidMetadata");
  }

  return body as { task: UploadTaskLifecycle };
}

export async function fetchKnowledgeBaseFileTree(input: {
  knowledgeBaseId: string;
  parentPath?: string;
  cursor?: string | null;
}): Promise<BundleTreePage> {
  const params = new URLSearchParams();

  if (input.parentPath) {
    params.set("parentPath", input.parentPath);
  }
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }

  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/files/tree${
      params.size ? `?${params}` : ""
    }`
  );

  if (!response.ok) {
    return {
      items: [],
      nextCursor: null
    };
  }

  return (await response.json()) as BundleTreePage;
}

export async function fetchKnowledgeBaseFileDetail(input: {
  knowledgeBaseId: string;
  path: string;
}): Promise<BundleFileDetail | null> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(
      input.knowledgeBaseId
    )}/files/detail?path=${encodeURIComponent(input.path)}`
  );

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as BundleFileDetail;
}

export async function deleteKnowledgeBaseFile(input: {
  knowledgeBaseId: string;
  path: string;
}): Promise<{ task: UploadTaskLifecycle } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(
      input.knowledgeBaseId
    )}/files/detail?path=${encodeURIComponent(input.path)}`,
    {
      method: "DELETE"
    }
  );
  const body = (await response.json()) as
    | { task: UploadTaskLifecycle }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.deleteFailed");
  }

  return body as { task: UploadTaskLifecycle };
}

export async function listUploadTasks(input: {
  knowledgeBaseId: string;
  cursor?: string | null;
}): Promise<UploadTaskPage> {
  const params = new URLSearchParams();

  if (input.cursor) {
    params.set("cursor", input.cursor);
  }

  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/tasks${
      params.size ? `?${params}` : ""
    }`
  );

  if (!response.ok) {
    return {
      items: [],
      nextCursor: null
    };
  }

  return (await response.json()) as UploadTaskPage;
}

export async function fetchUploadTaskDetail(input: {
  knowledgeBaseId: string;
  taskId: string;
  cursor?: string | null;
  sourceCursor?: string | null;
}): Promise<UploadTaskDetail | null> {
  const params = new URLSearchParams();

  if (input.cursor) {
    params.set("cursor", input.cursor);
  }
  if (input.sourceCursor) {
    params.set("sourceCursor", input.sourceCursor);
  }

  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/tasks/${encodeURIComponent(
      input.taskId
    )}${params.size ? `?${params}` : ""}`
  );

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as UploadTaskDetail;
}

export async function fetchKnowledgeBasePublicUrls(input: {
  knowledgeBaseId: string;
}): Promise<KnowledgeBasePublicUrls | null> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/public-urls`
  );

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as { publicUrls: KnowledgeBasePublicUrls };
  return body.publicUrls;
}

export async function listReleases(input: {
  knowledgeBaseId: string;
  cursor?: string | null;
}): Promise<CursorPage<ReleaseRecord>> {
  return fetchKnowledgeBaseList<ReleaseRecord>({
    knowledgeBaseId: input.knowledgeBaseId,
    path: "releases",
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {})
  });
}

export async function listBundleFiles(input: {
  knowledgeBaseId: string;
  cursor?: string | null;
}): Promise<CursorPage<BundleFileRecord>> {
  return fetchKnowledgeBaseList<BundleFileRecord>({
    knowledgeBaseId: input.knowledgeBaseId,
    path: "bundle-files",
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {})
  });
}

async function fetchKnowledgeBaseList<T>(input: {
  knowledgeBaseId: string;
  path: string;
  cursor?: string | null;
}): Promise<CursorPage<T>> {
  const params = new URLSearchParams();

  if (input.cursor) {
    params.set("cursor", input.cursor);
  }

  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/${input.path}${
      params.size ? `?${params}` : ""
    }`
  );

  if (!response.ok) {
    return {
      items: [],
      nextCursor: null
    };
  }

  return (await response.json()) as CursorPage<T>;
}

function readFailure(
  body:
    | { knowledgeBase: KnowledgeBase }
    | { task: UploadTaskLifecycle }
    | { key: PublicOpenApiKey; oneTimeKey: OneTimePublicOpenApiKey }
    | { deleted: true }
    | { error?: { messageKey?: string } },
  fallbackMessageKey: string
): ApiFailure {
  return {
    messageKey: "error" in body && body.error?.messageKey ? body.error.messageKey : fallbackMessageKey
  };
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(adminApiUrl(path), {
    ...init,
    credentials: "include"
  });

  if (response.status === 401 || response.status === 403) {
    authFailureHandler?.();
  }

  return response;
}

function adminApiUrl(path: string): string {
  const baseUrl = readAdminApiBaseUrl();
  return baseUrl ? `${baseUrl}${path}` : path;
}

function readAdminApiBaseUrl(): string {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  const value = meta.env?.VITE_ADMIN_API_BASE_URL?.trim() ?? "";
  return value.replace(/\/+$/, "");
}
