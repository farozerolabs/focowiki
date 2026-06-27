const SOURCE_FILE_ID_PATTERN = /^source-file-[0-9a-f-]{36}$/;

export type SourceFileTaskDeletionRequest =
  | {
      ok: true;
      sourceFileIds: string[];
    }
  | {
      ok: false;
      code: SourceFileTaskDeletionRequestErrorCode;
      messageKey: string;
    };

export type SourceFileTaskDeletionRequestErrorCode =
  | "INVALID_SOURCE_FILE_TASK_DELETION_REQUEST"
  | "INVALID_SOURCE_FILE_TASK_DELETION_ID"
  | "NO_SOURCE_FILE_TASK_DELETION_IDS"
  | "SOURCE_FILE_TASK_DELETION_LIMIT_EXCEEDED";

export function readSourceFileTaskDeletionRequest(
  body: Record<string, unknown>,
  limits: { maxSourceFileIds: number }
): SourceFileTaskDeletionRequest {
  if (!Array.isArray(body.sourceFileIds)) {
    return invalidTaskDeletionRequest("INVALID_SOURCE_FILE_TASK_DELETION_REQUEST");
  }

  if (body.sourceFileIds.some((value) => typeof value !== "string")) {
    return invalidTaskDeletionRequest("INVALID_SOURCE_FILE_TASK_DELETION_ID");
  }

  const sourceFileIds = uniqueSourceFileIds(body.sourceFileIds);

  if (sourceFileIds.length === 0) {
    return invalidTaskDeletionRequest("NO_SOURCE_FILE_TASK_DELETION_IDS");
  }

  if (sourceFileIds.length > limits.maxSourceFileIds) {
    return invalidTaskDeletionRequest("SOURCE_FILE_TASK_DELETION_LIMIT_EXCEEDED");
  }

  if (sourceFileIds.some((sourceFileId) => !SOURCE_FILE_ID_PATTERN.test(sourceFileId))) {
    return invalidTaskDeletionRequest("INVALID_SOURCE_FILE_TASK_DELETION_ID");
  }

  return {
    ok: true,
    sourceFileIds
  };
}

function invalidTaskDeletionRequest(
  code: SourceFileTaskDeletionRequestErrorCode
): SourceFileTaskDeletionRequest {
  return {
    ok: false,
    code,
    messageKey: "errors.sourceFileTaskDeletionInvalid"
  };
}

function uniqueSourceFileIds(values: unknown[]): string[] {
  return [...new Set(values.map((value) => (value as string).trim()))];
}
