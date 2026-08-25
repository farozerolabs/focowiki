import { describe, expect, it } from "vitest";
import {
  decideDocumentPublicationRecovery,
  limitDocumentPublicationRecovery
} from
  "../src/document-indexing/application/document-publication-recovery.js";

describe("document publication recovery", () => {
  it.each([
    ["source_body_empty", "permanent_input", "terminal"],
    ["projection_scope_page_conflict", "invariant", "quarantine"],
    ["registration_conflict", "invariant", "quarantine"],
    ["write_attempt_conflict", "invariant", "quarantine"],
    ["portable_record_order_invalid", "invariant", "quarantine"],
    ["portable_record_duplicate", "invariant", "quarantine"],
    ["23514", "invariant", "quarantine"],
    ["publication_generation_stale_base", "supersession", "recompute_scope"],
    ["publication_source_precondition_failed", "supersession", "recompute_scope"],
    ["publication_work_precondition_failed", "supersession", "recompute_scope"],
    ["40P01", "contention", "defer_activation"],
    ["scope_generation_lease_lost", "lease_loss", "inspect_or_reclaim"],
    ["scope_generation_deadline_exceeded", "lease_loss", "inspect_or_reclaim"],
    ["53000", "database_resource", "retry_infrastructure"],
    ["53100", "database_resource", "retry_infrastructure"],
    ["53200", "database_resource", "retry_infrastructure"],
    ["53300", "database_resource", "retry_infrastructure"],
    ["53400", "database_resource", "retry_infrastructure"],
    ["provider_unavailable", "provider_transient", "retry_provider"],
    ["projection_cleanup_failed", "cleanup_debt", "retry_cleanup"]
  ] as const)("classifies %s as %s", (code, recoveryClass, action) => {
    expect(decideDocumentPublicationRecovery(code)).toEqual({
      recoveryClass,
      action,
      consumesBusinessAttempt: recoveryClass === "permanent_input"
    });
  });

  it("quarantines a provider-stalled scope after three bounded attempts", () => {
    const decision = decideDocumentPublicationRecovery("provider_unavailable");
    expect(limitDocumentPublicationRecovery({ decision, attempt: 1 }))
      .toBe("retry_provider");
    expect(limitDocumentPublicationRecovery({ decision, attempt: 2 }))
      .toBe("retry_provider");
    expect(limitDocumentPublicationRecovery({ decision, attempt: 3 }))
      .toBe("quarantine");
  });

  it("keeps database resource exhaustion retryable beyond provider limits", () => {
    const decision = decideDocumentPublicationRecovery("53100");
    expect(limitDocumentPublicationRecovery({ decision, attempt: 3 }))
      .toBe("retry_infrastructure");
    expect(limitDocumentPublicationRecovery({ decision, attempt: 100 }))
      .toBe("retry_infrastructure");
  });

  it("replans the second consecutive lease loss for one immutable input", () => {
    const decision = decideDocumentPublicationRecovery(
      "scope_generation_lease_lost"
    );
    expect(limitDocumentPublicationRecovery({ decision, attempt: 1 }))
      .toBe("inspect_or_reclaim");
    expect(limitDocumentPublicationRecovery({ decision, attempt: 2 }))
      .toBe("recompute_scope");
  });

  it("replans a scope after its second consecutive execution deadline", () => {
    const decision = decideDocumentPublicationRecovery(
      "scope_generation_deadline_exceeded"
    );
    expect(limitDocumentPublicationRecovery({ decision, attempt: 1 }))
      .toBe("inspect_or_reclaim");
    expect(limitDocumentPublicationRecovery({ decision, attempt: 2 }))
      .toBe("recompute_scope");
  });
});
