import type { StagedDocumentPage } from
  "../application/document-generated-page-staging.js";

export function validateGeneratedPageContributorStage(input: {
  knowledgeBaseId: string;
  contributors: readonly {
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    sourceWorkPublicId: string;
    requiredSequence: number;
  }[];
  pages: readonly Omit<StagedDocumentPage, "pageCandidatePublicId">[];
  stagedAt: string;
}): void {
  if (!input.knowledgeBaseId
    || Buffer.byteLength(input.knowledgeBaseId, "utf8") > 255
    || input.contributors.length < 1 || input.contributors.length > 256
    || input.pages.length > 256
    || input.contributors.length * input.pages.length > 10_000
    || !Number.isFinite(Date.parse(input.stagedAt))
    || new Set(input.contributors.map((item) => item.sourceRevisionPublicId)).size
      !== input.contributors.length
    || input.contributors.some((item) => [
      item.sourceFilePublicId,
      item.sourceRevisionPublicId,
      item.sourceWorkPublicId
    ].some((value) => !value || Buffer.byteLength(value, "utf8") > 255)
      || !Number.isSafeInteger(item.requiredSequence)
      || item.requiredSequence < 1)
    || new Set(input.pages.map((page) => page.normalizedPath)).size
      !== input.pages.length
    || input.pages.some((page) => !page.logicalPath || !page.normalizedPath
      || !page.entryKind || !page.objectId
      || !/^[0-9a-f]{64}$/u.test(page.checksumSha256)
      || !Number.isSafeInteger(page.byteCount) || page.byteCount < 1)) {
    throw Object.assign(new Error(
      "Generated page repository error: invalid_input"
    ), { code: "invalid_input" });
  }
}
