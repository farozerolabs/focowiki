import { describe, expect, it } from "vitest";
import { retryablePublicationError } from
  "../src/document-indexing/infrastructure/production-document-publication-job-runtime.js";

describe("publication error classification", () => {
  it("does not repeat deterministic capacity and contract failures", () => {
    for (const code of [
      "publication_navigation_mutations_invalid",
      "publication_page_owner_revision_stale",
      "publication_job_relation_limit",
      "publication_job_term_limit",
      "publication_base_page_limit_exceeded",
      "navigation_delta_window_exceeded",
      "entry_limit_exceeded",
      "leaf_limit_exceeded",
      "mutation_set_invalid",
      "mutation_invalid"
    ]) expect(retryablePublicationError(code)).toBe(false);
  });

  it("keeps transient provider and transport failures retryable", () => {
    for (const code of [
      "search_provider_unavailable",
      "database_connection_failed",
      "object_storage_timeout"
    ]) expect(retryablePublicationError(code)).toBe(true);
  });
});
