import { describe, expect, it } from "vitest";
import { decideDocumentPublicationRecovery } from
  "../src/document-indexing/application/document-publication-recovery.js";

describe("document publication recovery", () => {
  it.each([
    ["source_body_empty", "permanent_input", "terminal"],
    ["projection_scope_page_conflict", "invariant", "quarantine"],
    ["registration_conflict", "invariant", "quarantine"],
    ["write_attempt_conflict", "invariant", "quarantine"],
    ["23514", "invariant", "quarantine"],
    ["publication_generation_stale_base", "supersession", "recompute_scope"],
    ["40P01", "contention", "defer_activation"],
    ["scope_generation_lease_lost", "lease_loss", "inspect_or_reclaim"],
    ["provider_unavailable", "provider_transient", "retry_provider"],
    ["projection_cleanup_failed", "cleanup_debt", "retry_cleanup"]
  ] as const)("classifies %s as %s", (code, recoveryClass, action) => {
    expect(decideDocumentPublicationRecovery(code)).toEqual({
      recoveryClass,
      action,
      consumesBusinessAttempt: recoveryClass === "permanent_input"
    });
  });
});
