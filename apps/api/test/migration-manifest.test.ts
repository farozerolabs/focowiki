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
  it("declares the complete migration chain through upgrade baseline recovery", () => {
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
    }, {
      fileName: "006_projection_publication_foundation.sql",
      sourceGeneration: "storage-vnext-v13-clean-document-indexing",
      targetGeneration: "storage-vnext-v14-projection-publication-coherence",
      safety: "compatible"
    }, {
      fileName: "007_projection_legacy_cleanup_gate.sql",
      sourceGeneration: "storage-vnext-v14-projection-publication-coherence",
      targetGeneration: "storage-vnext-v15-projection-legacy-cleanup-gate",
      safety: "compatible"
    }, {
      fileName: "008_projection_navigation_capacity.sql",
      sourceGeneration: "storage-vnext-v15-projection-legacy-cleanup-gate",
      targetGeneration: "storage-vnext-v16-projection-navigation-capacity",
      safety: "compatible"
    }, {
      fileName: "009_projection_resource_recovery.sql",
      sourceGeneration: "storage-vnext-v16-projection-navigation-capacity",
      targetGeneration: "storage-vnext-v17-projection-resource-recovery",
      safety: "compatible"
    }, {
      fileName: "010_projection_large_directory_deltas.sql",
      sourceGeneration: "storage-vnext-v17-projection-resource-recovery",
      targetGeneration: "storage-vnext-v18-projection-large-directory-deltas",
      safety: "compatible"
    }, {
      fileName: "011_projection_delta_lease_safety.sql",
      sourceGeneration: "storage-vnext-v18-projection-large-directory-deltas",
      targetGeneration: "storage-vnext-v19-projection-delta-lease-safety",
      safety: "compatible"
    }, {
      fileName: "012_projection_runtime_recovery.sql",
      sourceGeneration: "storage-vnext-v19-projection-delta-lease-safety",
      targetGeneration: "storage-vnext-v20-projection-runtime-recovery",
      safety: "compatible"
    }, {
      fileName: "013_single_job_publication_foundation.sql",
      sourceGeneration: "storage-vnext-v20-projection-runtime-recovery",
      targetGeneration: "storage-vnext-v21-single-job-publication-foundation",
      safety: "breaking_cutover"
    }, {
      fileName: "014_single_job_publication_upgrade_baseline.sql",
      sourceGeneration: "storage-vnext-v21-single-job-publication-foundation",
      targetGeneration:
        "storage-vnext-v22-single-job-publication-upgrade-baseline",
      safety: "breaking_cutover"
    }, {
      fileName: "015_single_job_publication_retry_recovery.sql",
      sourceGeneration:
        "storage-vnext-v22-single-job-publication-upgrade-baseline",
      targetGeneration:
        "storage-vnext-v23-single-job-publication-retry-recovery",
      safety: "breaking_cutover"
    }, {
      fileName: "016_single_job_publication_scale_safety.sql",
      sourceGeneration:
        "storage-vnext-v23-single-job-publication-retry-recovery",
      targetGeneration:
        "storage-vnext-v24-single-job-publication-scale-safety",
      safety: "breaking_cutover"
    }, {
      fileName: "017_single_job_publication_monotonic_recovery.sql",
      sourceGeneration:
        "storage-vnext-v24-single-job-publication-scale-safety",
      targetGeneration:
        "storage-vnext-v25-single-job-publication-monotonic-recovery",
      safety: "breaking_cutover"
    }, {
      fileName: "018_navigation_chain_reconciliation.sql",
      sourceGeneration:
        "storage-vnext-v25-single-job-publication-monotonic-recovery",
      targetGeneration:
        "storage-vnext-v26-navigation-chain-reconciliation",
      safety: "breaking_cutover"
    }, {
      fileName: "019_publication_window_cleanup_recovery.sql",
      sourceGeneration:
        "storage-vnext-v26-navigation-chain-reconciliation",
      targetGeneration:
        "storage-vnext-v27-publication-window-cleanup-recovery",
      safety: "breaking_cutover"
    }]);
    expect(MIGRATION_FILES).toEqual([
      "001_storage_vnext.sql",
      "002_document_queue_throughput.sql",
      "003_document_projection_throughput.sql",
      "004_projection_output_object_lifecycle.sql",
      "005_clean_document_indexing_boundary.sql",
      "006_projection_publication_foundation.sql",
      "007_projection_legacy_cleanup_gate.sql",
      "008_projection_navigation_capacity.sql",
      "009_projection_resource_recovery.sql",
      "010_projection_large_directory_deltas.sql",
      "011_projection_delta_lease_safety.sql",
      "012_projection_runtime_recovery.sql",
      "013_single_job_publication_foundation.sql",
      "014_single_job_publication_upgrade_baseline.sql",
      "015_single_job_publication_retry_recovery.sql",
      "016_single_job_publication_scale_safety.sql",
      "017_single_job_publication_monotonic_recovery.sql",
      "018_navigation_chain_reconciliation.sql",
      "019_publication_window_cleanup_recovery.sql"
    ]);
    expect(RUNTIME_SCHEMA_GENERATION).toBe(
      "storage-vnext-v27-publication-window-cleanup-recovery"
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

  it("initializes an absent schema and permits the declared breaking cutover source", () => {
    expect(createBootstrapPlan("absent").pendingFiles).toEqual([
      "001_storage_vnext.sql",
      "002_document_queue_throughput.sql",
      "003_document_projection_throughput.sql",
      "004_projection_output_object_lifecycle.sql",
      "005_clean_document_indexing_boundary.sql",
      "006_projection_publication_foundation.sql",
      "007_projection_legacy_cleanup_gate.sql",
      "008_projection_navigation_capacity.sql",
      "009_projection_resource_recovery.sql",
      "010_projection_large_directory_deltas.sql",
      "011_projection_delta_lease_safety.sql",
      "012_projection_runtime_recovery.sql",
      "013_single_job_publication_foundation.sql",
      "014_single_job_publication_upgrade_baseline.sql",
      "015_single_job_publication_retry_recovery.sql",
      "016_single_job_publication_scale_safety.sql",
      "017_single_job_publication_monotonic_recovery.sql",
      "018_navigation_chain_reconciliation.sql",
      "019_publication_window_cleanup_recovery.sql"
    ]);
    expect(createBootstrapPlan(RUNTIME_SCHEMA_GENERATION).pendingFiles).toEqual([]);
    expect(createBootstrapPlan(
      "storage-vnext-v20-projection-runtime-recovery"
    ).pendingFiles).toEqual([
      "013_single_job_publication_foundation.sql",
      "014_single_job_publication_upgrade_baseline.sql",
      "015_single_job_publication_retry_recovery.sql",
      "016_single_job_publication_scale_safety.sql",
      "017_single_job_publication_monotonic_recovery.sql",
      "018_navigation_chain_reconciliation.sql",
      "019_publication_window_cleanup_recovery.sql"
    ]);
    expect(createBootstrapPlan(
      "storage-vnext-v21-single-job-publication-foundation"
    ).pendingFiles).toEqual([
      "014_single_job_publication_upgrade_baseline.sql",
      "015_single_job_publication_retry_recovery.sql",
      "016_single_job_publication_scale_safety.sql",
      "017_single_job_publication_monotonic_recovery.sql",
      "018_navigation_chain_reconciliation.sql",
      "019_publication_window_cleanup_recovery.sql"
    ]);
    expect(createBootstrapPlan(
      "storage-vnext-v22-single-job-publication-upgrade-baseline"
    ).pendingFiles).toEqual([
      "015_single_job_publication_retry_recovery.sql",
      "016_single_job_publication_scale_safety.sql",
      "017_single_job_publication_monotonic_recovery.sql",
      "018_navigation_chain_reconciliation.sql",
      "019_publication_window_cleanup_recovery.sql"
    ]);
    expect(createBootstrapPlan(
      "storage-vnext-v23-single-job-publication-retry-recovery"
    ).pendingFiles).toEqual([
      "016_single_job_publication_scale_safety.sql",
      "017_single_job_publication_monotonic_recovery.sql",
      "018_navigation_chain_reconciliation.sql",
      "019_publication_window_cleanup_recovery.sql"
    ]);
    expect(createBootstrapPlan(
      "storage-vnext-v24-single-job-publication-scale-safety"
    ).pendingFiles).toEqual([
      "017_single_job_publication_monotonic_recovery.sql",
      "018_navigation_chain_reconciliation.sql",
      "019_publication_window_cleanup_recovery.sql"
    ]);
    expect(createBootstrapPlan(
      "storage-vnext-v25-single-job-publication-monotonic-recovery"
    ).pendingFiles).toEqual([
      "018_navigation_chain_reconciliation.sql",
      "019_publication_window_cleanup_recovery.sql"
    ]);
    expect(createBootstrapPlan(
      "storage-vnext-v26-navigation-chain-reconciliation"
    ).pendingFiles).toEqual([
      "019_publication_window_cleanup_recovery.sql"
    ]);
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
