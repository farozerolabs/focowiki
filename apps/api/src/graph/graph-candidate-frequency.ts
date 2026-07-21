import { normalizeSearchText } from "./graph-utils.js";

export type CandidateTermFrequency = {
  isFrequent(value: string): boolean;
  cacheSize(): number;
};

export function createCandidateTermFrequency(
  candidateDocumentTerms: Array<Set<string>>
): CandidateTermFrequency {
  const documentCount = candidateDocumentTerms.length;
  const documentsByTerm = new Map<string, number[]>();
  candidateDocumentTerms.forEach((terms, documentIndex) => {
    for (const term of new Set(Array.from(terms, normalizeCompactTerm).filter(Boolean))) {
      const documents = documentsByTerm.get(term) ?? [];
      documents.push(documentIndex);
      documentsByTerm.set(term, documents);
    }
  });
  const cache = new Map<string, boolean>();

  return {
    isFrequent(value) {
      const normalized = normalizeCompactTerm(value);
      if (!normalized || documentCount < 3) return false;

      const cached = cache.get(normalized);
      if (cached !== undefined) return cached;

      const maximumCommonDocuments = Math.max(2, Math.ceil(documentCount * 0.15));
      const matchingDocuments = new Set<number>();
      for (const [term, documentIndexes] of documentsByTerm) {
        if (term === normalized || term.includes(normalized)) {
          for (const documentIndex of documentIndexes) {
            matchingDocuments.add(documentIndex);
            if (matchingDocuments.size > maximumCommonDocuments) {
              cache.set(normalized, true);
              return true;
            }
          }
        }
      }

      cache.set(normalized, false);
      return false;
    },
    cacheSize() {
      return cache.size;
    }
  };
}

function normalizeCompactTerm(value: string): string {
  return normalizeSearchText(value).replace(/\s+/gu, "");
}
