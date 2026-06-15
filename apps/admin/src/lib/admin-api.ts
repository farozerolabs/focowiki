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

export type UploadTaskLifecycle = {
  id: string;
  operation?: "upload" | "delete_source" | "delete_knowledge_base";
  startedAt: string;
  endedAt: string | null;
  lifecycle: "running" | "ended";
  sourceCount?: number;
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

export async function checkAdminSession(): Promise<boolean> {
  try {
    const response = await fetch("/admin/api/session", {
      credentials: "include"
    });

    return response.ok;
  } catch {
    return false;
  }
}

export async function loginAdmin(input: { username: string; password: string }): Promise<boolean> {
  const response = await fetch("/admin/api/login", {
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
  await fetch("/admin/api/logout", {
    method: "POST",
    credentials: "include"
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

  const response = await fetch(`/admin/api/knowledge-bases${params.size ? `?${params}` : ""}`, {
    credentials: "include"
  });

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
  const response = await fetch("/admin/api/knowledge-bases", {
    method: "POST",
    credentials: "include",
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
  const response = await fetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}`,
    {
      method: "DELETE",
      credentials: "include"
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

export async function uploadKnowledgeBaseSources(input: {
  knowledgeBaseId: string;
  files: File[];
}): Promise<{ task: UploadTaskLifecycle } | ApiFailure> {
  const formData = new FormData();

  input.files.forEach((file) => {
    formData.append("files", file);
  });

  const response = await fetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/uploads`,
    {
      method: "POST",
      credentials: "include",
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

  const response = await fetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/files/tree${
      params.size ? `?${params}` : ""
    }`,
    {
      credentials: "include"
    }
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
  const response = await fetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(
      input.knowledgeBaseId
    )}/files/detail?path=${encodeURIComponent(input.path)}`,
    {
      credentials: "include"
    }
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
  const response = await fetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(
      input.knowledgeBaseId
    )}/files/detail?path=${encodeURIComponent(input.path)}`,
    {
      method: "DELETE",
      credentials: "include"
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

  const response = await fetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/tasks${
      params.size ? `?${params}` : ""
    }`,
    {
      credentials: "include"
    }
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

  const response = await fetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/tasks/${encodeURIComponent(
      input.taskId
    )}${params.size ? `?${params}` : ""}`,
    {
      credentials: "include"
    }
  );

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as UploadTaskDetail;
}

export async function fetchKnowledgeBasePublicUrls(input: {
  knowledgeBaseId: string;
}): Promise<KnowledgeBasePublicUrls | null> {
  const response = await fetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/public-urls`,
    {
      credentials: "include"
    }
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

  const response = await fetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/${input.path}${
      params.size ? `?${params}` : ""
    }`,
    {
      credentials: "include"
    }
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
    | { deleted: true }
    | { error?: { messageKey?: string } },
  fallbackMessageKey: string
): ApiFailure {
  return {
    messageKey: "error" in body && body.error?.messageKey ? body.error.messageKey : fallbackMessageKey
  };
}
