import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("document processing context contract", () => {
  it("pins context to the claimed fixed work and settings revision", async () => {
    const source = await readFile(new URL(
      "../src/document-indexing/infrastructure/postgres-document-work-context.ts",
      import.meta.url
    ), "utf8");

    expect(source).toMatch(
      /active\.current_source_revision_public_id = job\.source_revision_public_id/u
    );
    expect(source).toMatch(/settings\.public_id = job\.runtime_settings_revision_public_id/u);
    expect(source).toMatch(/artifact_work\.lease_owner = \$\{work\.leaseOwner\}/u);
    expect(source).toMatch(/artifact_work\.work_kind = \$\{work\.kind\}/u);
    expect(source).not.toMatch(/runtime_setting_current/u);
  });

  it("persists actual model lifecycle fields and rejects a missing job", async () => {
    const source = await readFile(new URL(
      "../src/document-indexing/infrastructure/postgres-document-model-trace.ts",
      import.meta.url
    ), "utf8");

    for (const field of [
      "model_status", "model_name", "model_started_at", "model_ended_at",
      "model_warning_count", "model_error_code"
    ]) expect(source).toMatch(new RegExp(field, "u"));
    expect(source).toMatch(/updated\.length !== 1/u);
  });
});
