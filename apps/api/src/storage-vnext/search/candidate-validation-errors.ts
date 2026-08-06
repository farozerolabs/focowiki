export type StorageVnextSearchCandidateValidationErrorCode =
  | "candidate_checksum_mismatch"
  | "candidate_count_mismatch"
  | "candidate_document_invalid"
  | "candidate_hydration_mismatch"
  | "candidate_latency_exceeded"
  | "candidate_ndcg_below_minimum"
  | "candidate_order_nondeterministic"
  | "candidate_query_matrix_incomplete"
  | "candidate_recall_below_minimum"
  | "candidate_settings_mismatch"
  | "candidate_validation_failed"
  | "provider_capability_unavailable";

export class StorageVnextSearchCandidateValidationError extends Error {
  public constructor(
    public readonly code: StorageVnextSearchCandidateValidationErrorCode,
    public readonly validationKind: string | null = null
  ) {
    super(
      `Storage vNext search candidate validation error: ${code}`
        + (validationKind ? ` [kind=${validationKind}]` : "")
    );
    this.name = "StorageVnextSearchCandidateValidationError";
  }
}

export function candidateValidationError(
  code: StorageVnextSearchCandidateValidationErrorCode,
  validationKind?: string
) {
  return new StorageVnextSearchCandidateValidationError(
    code,
    validationKind ?? null
  );
}
