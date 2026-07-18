export type SourceFileRetryAcceptance =
  | {
      outcome: "accepted";
      kind: "source_processing" | "publication";
      coalesced: boolean;
      roleJobId: string;
    }
  | { outcome: "not_found" }
  | { outcome: "not_allowed" }
  | { outcome: "resource_conflict" };

export type SourceFileRetryRepository = {
  accept: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    runAfter: string;
    maxAttempts: number;
  }) => Promise<SourceFileRetryAcceptance>;
};
