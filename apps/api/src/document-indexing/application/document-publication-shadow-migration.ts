export function decideDocumentPublicationShadowContinuation(input: Readonly<{
  expectedPathCount: number;
  processedPathCount: number;
  pageItemCount: number;
  nextCursor: string | null;
}>): Readonly<{
  state: "building" | "complete";
  nextCursor: string | null;
}> {
  for (const value of [input.expectedPathCount, input.processedPathCount,
    input.pageItemCount]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw shadowMigrationError("SHADOW_PROGRESS_INVALID");
    }
  }
  const nextProcessed = input.processedPathCount + input.pageItemCount;
  if (nextProcessed > input.expectedPathCount) {
    throw shadowMigrationError("SHADOW_PROGRESS_EXCEEDS_SNAPSHOT");
  }
  if (input.nextCursor !== null) {
    if (!input.nextCursor || input.pageItemCount === 0
      || nextProcessed >= input.expectedPathCount) {
      throw shadowMigrationError("SHADOW_CURSOR_INVALID");
    }
    return { state: "building", nextCursor: input.nextCursor };
  }
  if (nextProcessed !== input.expectedPathCount) {
    throw shadowMigrationError("SHADOW_SNAPSHOT_DRIFT");
  }
  return { state: "complete", nextCursor: null };
}

export function orderDocumentPublicationCanaries(input: readonly Readonly<{
  knowledgeBaseId: string;
  activePathCount: number;
}>[]): readonly string[] {
  return [...input].sort((left, right) =>
    left.activePathCount - right.activePathCount
      || left.knowledgeBaseId.localeCompare(right.knowledgeBaseId, "en-US"))
    .map((item) => item.knowledgeBaseId);
}

function shadowMigrationError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
