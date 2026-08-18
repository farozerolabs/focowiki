import type { DocumentGraphCandidate } from
  "./document-model-graph-enrichment.js";

export type DocumentInternalHybridFamily =
  | "exact"
  | "lexical"
  | "jieba"
  | "metadata"
  | "content_vector";

export type DocumentInternalHybridHit = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
  evidenceExcerpt: string;
  rankingTerms?: readonly string[];
};

export type DocumentInternalHybridCandidate = DocumentGraphCandidate & {
  reciprocalRankScore: number;
  evidenceFamilies: readonly DocumentInternalHybridFamily[];
};

const RRF_CONSTANT = 60;
const FAMILY_WEIGHT: Readonly<Record<DocumentInternalHybridFamily, number>> = {
  exact: 8,
  lexical: 5,
  jieba: 4,
  metadata: 4,
  content_vector: 5
};

export function fuseDocumentInternalHybridCandidates(input: {
  currentSourceFilePublicId: string;
  limit: number;
  lanes: readonly {
    family: DocumentInternalHybridFamily;
    hits: readonly DocumentInternalHybridHit[];
  }[];
}): DocumentInternalHybridCandidate[] {
  if (!input.currentSourceFilePublicId
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
    throw new Error("Document internal hybrid candidate input is invalid");
  }
  const fused = new Map<string, {
    hit: DocumentInternalHybridHit;
    score: number;
    families: Set<DocumentInternalHybridFamily>;
    firstRank: number;
  }>();
  for (const lane of input.lanes) {
    const seen = new Set<string>();
    lane.hits.forEach((hit, index) => {
      const key = identity(hit);
      if (hit.sourceFilePublicId === input.currentSourceFilePublicId
        || seen.has(key)) return;
      validateHit(hit);
      seen.add(key);
      const current = fused.get(key) ?? {
        hit,
        score: 0,
        families: new Set<DocumentInternalHybridFamily>(),
        firstRank: index + 1
      };
      current.score += FAMILY_WEIGHT[lane.family] / (RRF_CONSTANT + index + 1);
      current.families.add(lane.family);
      current.firstRank = Math.min(current.firstRank, index + 1);
      if (!current.hit.evidenceExcerpt && hit.evidenceExcerpt) current.hit = hit;
      fused.set(key, current);
    });
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score
      || left.firstRank - right.firstRank
      || left.hit.logicalPath.localeCompare(right.hit.logicalPath, "en")
      || identity(left.hit).localeCompare(identity(right.hit), "en"))
    .slice(0, input.limit)
    .map(({ hit, score, families }) => ({
      sourceFilePublicId: hit.sourceFilePublicId,
      sourceRevisionPublicId: hit.sourceRevisionPublicId,
      logicalPath: hit.logicalPath,
      title: hit.title,
      kind: "document",
      rankingTerms: [...new Set(hit.rankingTerms ?? [])].slice(0, 100),
      evidenceExcerpt: hit.evidenceExcerpt,
      retrievalScore: score,
      retrievalFamilies: [...families].sort(),
      reciprocalRankScore: score,
      evidenceFamilies: [...families].sort()
    }));
}

export function hydrateDocumentInternalHybridCandidates(input: {
  candidates: readonly DocumentInternalHybridCandidate[];
  eligible: readonly {
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    logicalPath: string;
    title: string;
    kind: string;
  }[];
}): DocumentInternalHybridCandidate[] {
  const eligible = new Map(input.eligible.map((item) => [identity(item), item]));
  return input.candidates.flatMap((candidate) => {
    const source = eligible.get(identity(candidate));
    return source ? [{
      ...candidate,
      logicalPath: source.logicalPath,
      title: source.title,
      kind: source.kind
    }] : [];
  });
}

function identity(hit: Pick<DocumentInternalHybridHit,
"sourceFilePublicId" | "sourceRevisionPublicId">): string {
  return `${hit.sourceFilePublicId}\0${hit.sourceRevisionPublicId}`;
}

function validateHit(hit: DocumentInternalHybridHit): void {
  if (!hit.sourceFilePublicId || !hit.sourceRevisionPublicId
    || !hit.logicalPath || !hit.title
    || Buffer.byteLength(hit.evidenceExcerpt, "utf8") > 8_192) {
    throw new Error("Document internal hybrid hit is invalid");
  }
}
