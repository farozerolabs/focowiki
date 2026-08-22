import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(
    `../src/document-indexing/infrastructure/${path}`,
    import.meta.url
  ), "utf8");
}

describe("document publication architecture contract", () => {
  it("moves verified-reservation release outside projection success", () => {
    expect(existsSync(new URL(
      "../src/document-indexing/infrastructure/production-document-scope-projector.ts",
      import.meta.url
    ))).toBe(false);
    const runtime = source("production-document-publication-scope-runtime.ts");
    expect(runtime).not.toContain("releaseVerifiedReservation");
  });

  it("routes deletion through the same generated artifact publisher", () => {
    const deletion = source("production-document-deletion-projection.ts");

    expect(deletion).not.toContain(
      "createPostgresDocumentDeletionProjectionCommit"
    );
    expect(deletion).not.toContain(
      "createProductionDocumentDeletionPageStaging"
    );
    expect(deletion).toContain("publicationGenerationCoordinator");
  });

  it("leaves non-document operation convergence to its owning worker", () => {
    const activation = source("postgres-document-publication-work-activation.ts");

    expect(activation).toContain(
      "operation.operation_kind IN ('source_replace', 'source_file_move')"
    );
    expect(activation).not.toContain("operation.operation_kind <> 'upload'");
  });
});
