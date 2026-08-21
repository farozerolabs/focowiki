import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_MANIFEST,
  MigrationManifestValidationError,
  UnsupportedMigrationGenerationError,
  createBootstrapPlan,
  validateMigrationManifest,
  type MigrationDescriptor
} from "../src/db/migration-manifest.js";
import { MIGRATION_FILES, RUNTIME_SCHEMA_GENERATION } from
  "../src/db/migrations.js";

describe("document indexing migration manifest", () => {
  it("declares a clean bootstrap followed by the compatible throughput upgrade", () => {
    expect(MIGRATION_MANIFEST).toEqual([{
      fileName: "001_storage_vnext.sql",
      sourceGeneration: "absent",
      targetGeneration: "storage-vnext-v9-document-indexing-hybrid",
      safety: "clean_bootstrap"
    }, {
      fileName: "002_document_queue_throughput.sql",
      sourceGeneration: "storage-vnext-v9-document-indexing-hybrid",
      targetGeneration: "storage-vnext-v10-document-indexing-throughput",
      safety: "compatible"
    }, {
      fileName: "003_document_projection_throughput.sql",
      sourceGeneration: "storage-vnext-v10-document-indexing-throughput",
      targetGeneration: "storage-vnext-v11-projection-throughput",
      safety: "compatible"
    }, {
      fileName: "004_projection_output_object_lifecycle.sql",
      sourceGeneration: "storage-vnext-v11-projection-throughput",
      targetGeneration: "storage-vnext-v12-projection-object-lifecycle",
      safety: "compatible"
    }, {
      fileName: "005_clean_document_indexing_boundary.sql",
      sourceGeneration: "storage-vnext-v12-projection-object-lifecycle",
      targetGeneration: "storage-vnext-v13-clean-document-indexing",
      safety: "breaking_reset"
    }]);
    expect(MIGRATION_FILES).toEqual([
      "001_storage_vnext.sql",
      "002_document_queue_throughput.sql",
      "003_document_projection_throughput.sql",
      "004_projection_output_object_lifecycle.sql",
      "005_clean_document_indexing_boundary.sql"
    ]);
    expect(RUNTIME_SCHEMA_GENERATION).toBe(
      "storage-vnext-v13-clean-document-indexing"
    );
  });

  it("covers the migration directory exactly once", () => {
    const files = readdirSync(resolve(import.meta.dirname, "../migrations"))
      .filter((fileName) => /^\d{3}_.+\.sql$/u.test(fileName))
      .sort();
    expect([...MIGRATION_FILES]).toEqual(files);
    expect(() => validateMigrationManifest(MIGRATION_MANIFEST, {
      availableFiles: files,
      expectedRuntimeGeneration: RUNTIME_SCHEMA_GENERATION
    })).not.toThrow();
  });

  it("initializes only an absent schema and rejects persisted generations", () => {
    expect(createBootstrapPlan("absent").pendingFiles).toEqual([
      "001_storage_vnext.sql",
      "002_document_queue_throughput.sql",
      "003_document_projection_throughput.sql",
      "004_projection_output_object_lifecycle.sql",
      "005_clean_document_indexing_boundary.sql"
    ]);
    expect(createBootstrapPlan(RUNTIME_SCHEMA_GENERATION).pendingFiles).toEqual([]);
    for (const generation of [
      "storage-vnext-v9-document-indexing-hybrid",
      "storage-vnext-v10-document-indexing-throughput",
      "storage-vnext-v11-projection-throughput",
      "storage-vnext-v12-projection-object-lifecycle",
      "storage-vnext-v13-active-projection-output-repair",
      "storage-vnext-v1",
      "storage-vnext-v2",
      "storage-vnext-v4-continuous-pipeline",
      "unknown-generation-v99"
    ]) expect(() => createBootstrapPlan(generation)).toThrow(
      UnsupportedMigrationGenerationError
    );
  });

  it("rejects invalid manifests and file coverage drift", () => {
    expect(() => validateMigrationManifest([
      MIGRATION_MANIFEST[0]!, MIGRATION_MANIFEST[0]!
    ])).toThrow(MigrationManifestValidationError);
    expect(() => validateMigrationManifest([{
      ...MIGRATION_MANIFEST[0]!,
      sourceGeneration: "previous"
    }] as readonly MigrationDescriptor[])).toThrow(MigrationManifestValidationError);
    expect(() => validateMigrationManifest(MIGRATION_MANIFEST, {
      availableFiles: []
    })).toThrow(MigrationManifestValidationError);
  });
});
