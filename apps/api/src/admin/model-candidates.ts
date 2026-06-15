export type ModelCandidateSource = {
  id: string;
  fileName: string;
  title: string;
  type?: string;
  tags?: string[];
};

const DEFAULT_CANDIDATE_LIMIT = 32;

export function selectModelCandidatePaths(input: {
  source: ModelCandidateSource;
  sources: ModelCandidateSource[];
  limit?: number;
}): string[] {
  const limit = input.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const sourceTokens = tokenizeSource(input.source);

  return input.sources
    .map((candidate, index) => ({
      candidate,
      index,
      score: candidate.id === input.source.id ? -1 : scoreCandidate(sourceTokens, candidate)
    }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((item) => toMarkdownHref(`pages/${item.candidate.fileName.trim()}`));
}

function scoreCandidate(sourceTokens: Set<string>, candidate: ModelCandidateSource): number {
  let score = 0;

  for (const token of tokenizeSource(candidate)) {
    if (sourceTokens.has(token)) {
      score += 1;
    }
  }

  return score;
}

function tokenizeSource(source: ModelCandidateSource): Set<string> {
  return new Set(
    [source.title, source.fileName, source.type ?? "", ...(source.tags ?? [])]
      .join(" ")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter(Boolean)
  );
}

function toMarkdownHref(path: string): string {
  return `/${path.split("/").map(encodeURIComponent).join("/")}`;
}
