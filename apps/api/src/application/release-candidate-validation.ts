import type {
  ReleasePublicationRepository,
  ReleaseValidationResult
} from "./ports/release-publication-repository.js";

const DEFAULT_ISSUE_LIMIT = 100;
const MAX_ISSUE_LIMIT = 500;

export class ReleaseCandidateValidationError extends Error {
  public readonly result: ReleaseValidationResult;

  public constructor(result: ReleaseValidationResult) {
    const summary = result.issues
      .map((issue) => `${issue.ruleId}${issue.path ? ` ${issue.path}` : ""}`)
      .join(", ");
    super([
      `Release validation failed: ${summary}`,
      ...(result.truncated ? ["additional issues omitted"] : [])
    ].join("; "));
    this.name = "ReleaseCandidateValidationError";
    this.result = result;
  }
}

export async function assertReleaseCandidate(input: {
  repository: Pick<ReleasePublicationRepository, "validateRelease">;
  knowledgeBaseId: string;
  releaseId: string;
  requireGraph: boolean;
  issueLimit?: number;
}): Promise<ReleaseValidationResult> {
  const result = await input.repository.validateRelease({
    knowledgeBaseId: input.knowledgeBaseId,
    releaseId: input.releaseId,
    requireGraph: input.requireGraph,
    issueLimit: normalizeIssueLimit(input.issueLimit)
  });
  if (result.issues.length > 0) {
    throw new ReleaseCandidateValidationError(result);
  }
  return result;
}

function normalizeIssueLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    return DEFAULT_ISSUE_LIMIT;
  }
  return Math.min(value as number, MAX_ISSUE_LIMIT);
}
