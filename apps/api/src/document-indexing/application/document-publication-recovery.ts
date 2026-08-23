export type DocumentPublicationRecoveryDecision = Readonly<{
  recoveryClass: "permanent_input" | "invariant" | "supersession"
    | "contention" | "lease_loss" | "provider_transient" | "cleanup_debt";
  action: "terminal" | "quarantine" | "recompute_scope"
    | "defer_activation" | "inspect_or_reclaim" | "retry_provider"
    | "retry_cleanup";
  consumesBusinessAttempt: boolean;
}>;

export const DOCUMENT_PUBLICATION_PROVIDER_MAXIMUM_ATTEMPTS = 3;

const PERMANENT_INPUT = new Set([
  "source_body_empty", "source_frontmatter_invalid", "source_utf8_invalid",
  "source_size_limit", "invalid_source_contract", "metadata_too_large",
  "projection_scope_contribution_count_invalid"
]);
const INVARIANTS = new Set([
  "projection_path_owner_mismatch", "projection_directory_owner_mismatch",
  "projection_scope_output_conflict", "projection_scope_page_conflict",
  "projection_scope_navigation_conflict",
  "projection_scope_owner_version_conflict",
  "scope_generation_output_diverged",
  "publication_generation_closure_incomplete",
  "registration_conflict", "write_attempt_conflict", "23514"
]);
const SUPERSESSION = new Set([
  "publication_generation_stale_base", "document_revision_superseded",
  "scope_snapshot_not_mutable"
]);
const CONTENTION = new Set([
  "40P01", "40001", "55P03",
  "publication_activation_contention_deferred",
  "publication_activation_deadline_deferred"
]);
const LEASE_LOSS = new Set([
  "scope_generation_lease_lost", "projection_scope_lease_lost",
  "document_projection_lease_lost"
]);
const CLEANUP_DEBT = new Set([
  "projection_cleanup_failed", "projection_cleanup_lease_lost",
  "projection_cleanup_retry_exhausted"
]);

export function decideDocumentPublicationRecovery(
  code: string
): DocumentPublicationRecoveryDecision {
  if (PERMANENT_INPUT.has(code)) return decision(
    "permanent_input", "terminal", true
  );
  if (INVARIANTS.has(code)) return decision(
    "invariant", "quarantine", false
  );
  if (SUPERSESSION.has(code)) return decision(
    "supersession", "recompute_scope", false
  );
  if (CONTENTION.has(code)) return decision(
    "contention", "defer_activation", false
  );
  if (LEASE_LOSS.has(code)) return decision(
    "lease_loss", "inspect_or_reclaim", false
  );
  if (CLEANUP_DEBT.has(code)) return decision(
    "cleanup_debt", "retry_cleanup", false
  );
  return decision("provider_transient", "retry_provider", false);
}

export function limitDocumentPublicationRecovery(input: {
  decision: DocumentPublicationRecoveryDecision;
  attempt: number;
}): DocumentPublicationRecoveryDecision["action"] {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("Document publication recovery attempt is invalid");
  }
  return input.decision.action === "retry_provider"
    && input.attempt >= DOCUMENT_PUBLICATION_PROVIDER_MAXIMUM_ATTEMPTS
    ? "quarantine"
    : input.decision.action;
}

function decision(
  recoveryClass: DocumentPublicationRecoveryDecision["recoveryClass"],
  action: DocumentPublicationRecoveryDecision["action"],
  consumesBusinessAttempt: boolean
): DocumentPublicationRecoveryDecision {
  return { recoveryClass, action, consumesBusinessAttempt };
}
