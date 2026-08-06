export type StorageVnextSearchHydrationRecord = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
};

export interface StorageVnextSearchHydrationPort {
  hydrateCurrentSources(input: {
    knowledgeBaseId: string;
    candidatePublicId?: string;
    sourceFilePublicIds: readonly string[];
  }): Promise<readonly StorageVnextSearchHydrationRecord[]>;
}

export type StorageVnextSearchCandidateIdentity = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
};

export function assertStorageVnextSearchHydration(
  candidates: readonly StorageVnextSearchCandidateIdentity[],
  hydrated: readonly StorageVnextSearchHydrationRecord[]
): void {
  const current = new Map(hydrated.map((item) => [item.sourceFilePublicId, item]));
  for (const candidate of candidates) {
    const item = current.get(candidate.sourceFilePublicId);
    if (
      !item
      || item.sourceRevisionPublicId !== candidate.sourceRevisionPublicId
      || item.logicalPath !== candidate.logicalPath
    ) throw new Error("candidate_hydration_mismatch");
  }
}
