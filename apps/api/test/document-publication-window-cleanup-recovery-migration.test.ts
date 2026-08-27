import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/019_publication_window_cleanup_recovery.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();
const failureRepository = readFileSync(resolve(
  import.meta.dirname,
  "../src/document-indexing/infrastructure/"
    + "postgres-document-publication-job-failure.ts"
), "utf8");
const outputCleanup = readFileSync(resolve(
  import.meta.dirname,
  "../src/document-indexing/infrastructure/"
    + "postgres-document-publication-output-cleanup.ts"
), "utf8");

describe("publication window and cleanup recovery migration", () => {
  it("requeues both production publication failure classes", () => {
    expect(migration).toContain("'navigation_chain_invalid'");
    expect(migration).toContain("'publication_object_metadata_missing'");
    expect(migration).toContain("work_kind in ('knowledge_projection', 'activate')");
    expect(migration).toContain("outcome = 'pending'");
  });

  it("replaces immediate failed-output deletion with delayed cleanup", () => {
    expect(migration).toContain("'publication-job-output-v1'");
    expect(migration).toContain("'publication-job-output-v2'");
    expect(migration).toContain("interval '1 day'");
    expect(migration).toContain("state = 'completed'");
    expect(failureRepository).toContain(
      "deferPostgresDocumentPublicationOutputCleanup"
    );
    expect(outputCleanup).toContain(
      "INSERT INTO focowiki.cleanup_actions"
    );
    expect(outputCleanup).toContain("PUBLICATION_OUTPUT_CLEANUP_GRACE_MILLISECONDS");
  });

  it("advances the runtime generation after recovery", () => {
    expect(migration).toContain(
      "storage-vnext-v27-publication-window-cleanup-recovery"
    );
  });
});
