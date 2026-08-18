import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("document upload finalization contract", () => {
  const source = readFileSync(resolve(
    import.meta.dirname,
    "../src/storage-vnext/upload/postgres-finalization.ts"
  ), "utf8");

  it("creates one revision-scoped document job under the upload operation", () => {
    for (const required of [
      "source_file_active_revisions",
      "document_processing_jobs",
      "document_artifact_work",
      "DOCUMENT_WORK_KINDS",
      "documentWorkResourceLane",
      "runtime_settings_revision_public_id",
      "generation_model_configuration_public_id",
      "embedding_configuration_revision_public_id",
      "semantic_generation_public_id",
      "maximum_attempts"
    ]) {
      expect(source, required).toContain(required);
    }
    expect(source).toContain("operation_public_id: session.operation_public_id");
  });

  it("does not create legacy source work or current-revision compatibility rows", () => {
    for (const removed of [
      "source_file_current_revisions",
      'work_kind: "source"',
      'status: "pending"',
      'revision_role: "current"',
      "source-operation"
    ]) {
      expect(source, removed).not.toContain(removed);
    }
    expect(source).not.toMatch(/"phase",\s*"attempt_count"/u);
    expect(source).not.toMatch(/"checkpoint",\s*"lease_owner"/u);
    expect(source).not.toContain("knowledge_base_activation_revisions");
  });
});
