import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseClient } from "../src/db/client.js";
import {
  MigrationWorkNotDrainedError,
  assertMigrationWorkDrained,
  inspectMigrationWork
} from "../src/db/migration-preflight.js";

describe("migration preflight", () => {
  it("accepts a fully drained database", async () => {
    const database = fakeDatabase({});

    await expect(assertMigrationWorkDrained(database)).resolves.toBeUndefined();
    expect(database.calls).toBeGreaterThan(1);
  });

  it("rejects every non-terminal work class with bounded safe counts", async () => {
    const database = fakeDatabase({
      sourceFiles: 2,
      dispatchMarkers: 3,
      roleJobs: 4,
      publicationImpacts: 5,
      frozenGenerations: 6,
      resourceOperations: 7,
      deletionIntents: 8,
      uploadSessions: 9,
      cleanupObjects: 10,
      knowledgeBaseMaintenanceRequests: 11,
      projectionRepairs: 12,
      lexicalRebuilds: 13,
      projectionCompactions: 14,
      maintenanceCandidateGenerations: 15
    });

    const snapshot = await inspectMigrationWork(database);
    expect(snapshot.total).toBe(119);
    await expect(assertMigrationWorkDrained(database)).rejects.toEqual(
      new MigrationWorkNotDrainedError(snapshot)
    );
  });

  it("caps reported values without exposing records", async () => {
    const database = fakeDatabase({ sourceFiles: 1_000_001 });

    await expect(assertMigrationWorkDrained(database)).rejects.toMatchObject({
      code: "MIGRATION_WORK_NOT_DRAINED",
      snapshot: { sourceFiles: 1_000_000, capped: true }
    });
  });

  it("does not query optional work relations missing from an older schema", async () => {
    const database = fakeDatabase(
      { projectionRepairs: 2 },
      {
        maintenance_requests: false,
        projection_repairs: true,
        projection_repair_subtasks: false,
        lexical_rebuilds: false,
        lexical_rebuild_work_items: false,
        projection_compactions: false
      }
    );

    await expect(inspectMigrationWork(database)).resolves.toMatchObject({
      projectionRepairs: 2,
      lexicalRebuilds: 0,
      knowledgeBaseMaintenanceRequests: 0
    });
    expect(database.statements.slice(1).join(" ")).not.toContain(
      "active_projection_repair_subtasks"
    );
    expect(database.statements.slice(1).join(" ")).not.toContain(
      "active_lexical_rebuilds"
    );
  });

  it("counts repair and rebuild candidates separately from normal publication work", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/db/migration-preflight.ts"),
      "utf8"
    ).replace(/\s+/g, " ").toLowerCase();

    expect(source).toContain(
      "coalesce( to_jsonb(generation)->>'generation_kind', 'normal' ) "
      + "not in ('projection_repair', 'lexical_rebuild')"
    );
    expect(source).toContain(
      "coalesce( to_jsonb(generation)->>'generation_kind', 'normal' ) "
      + "in ('projection_repair', 'lexical_rebuild')"
    );
    expect(source).toContain("generation.state in ('frozen', 'building', 'validating')");
  });
});

function fakeDatabase(
  overrides: Partial<Record<WorkKey, number>>,
  capabilityOverrides: Partial<MigrationCapabilityFixture> = {}
) {
  let calls = 0;
  const statements: string[] = [];
  const row = {
    source_files: 0,
    dispatch_markers: 0,
    role_jobs: 0,
    publication_impacts: 0,
    frozen_generations: 0,
    resource_operations: 0,
    deletion_intents: 0,
    upload_sessions: 0,
    cleanup_objects: 0,
    maintenance_candidate_generations: 0,
    capped: false
  };
  for (const [key, value] of Object.entries(overrides)) {
    const column = columns[key as BaseWorkKey];
    if (!column) continue;
    const bounded = Math.min(value, 1_000_000);
    row[column] = bounded as never;
    row.capped ||= value > bounded;
  }
  const tagged = async (segments: TemplateStringsArray) => {
    calls += 1;
    const statement = segments.join(" ");
    statements.push(statement);
    if (statement.includes("migration_capabilities")) {
      return [{
        maintenance_requests: true,
        projection_repairs: true,
        projection_repair_subtasks: true,
        lexical_rebuilds: true,
        lexical_rebuild_work_items: true,
        projection_compactions: true,
        ...capabilityOverrides
      }];
    }
    for (const [key, marker] of Object.entries(optionalQueryMarkers)) {
      if (statement.includes(marker)) {
        const value = overrides[key as WorkKey] ?? 0;
        return [{
          count: Math.min(value, 1_000_000),
          capped: value > 1_000_000
        }];
      }
    }
    return [row];
  };
  const database = tagged as unknown as DatabaseClient & {
    readonly calls: number;
    readonly statements: readonly string[];
  };
  Object.defineProperty(database, "calls", { get: () => calls });
  Object.defineProperty(database, "statements", { get: () => statements });
  return database;
}

type MigrationCapabilityFixture = {
  maintenance_requests: boolean;
  projection_repairs: boolean;
  projection_repair_subtasks: boolean;
  lexical_rebuilds: boolean;
  lexical_rebuild_work_items: boolean;
  projection_compactions: boolean;
};

type WorkKey =
  | "sourceFiles"
  | "dispatchMarkers"
  | "roleJobs"
  | "publicationImpacts"
  | "frozenGenerations"
  | "resourceOperations"
  | "deletionIntents"
  | "uploadSessions"
  | "cleanupObjects"
  | "knowledgeBaseMaintenanceRequests"
  | "projectionRepairs"
  | "lexicalRebuilds"
  | "projectionCompactions"
  | "maintenanceCandidateGenerations";

type BaseWorkKey = Exclude<
  WorkKey,
  | "knowledgeBaseMaintenanceRequests"
  | "projectionRepairs"
  | "lexicalRebuilds"
  | "projectionCompactions"
>;

const columns: Record<BaseWorkKey, keyof ReturnType<typeof rawRow>> = {
  sourceFiles: "source_files",
  dispatchMarkers: "dispatch_markers",
  roleJobs: "role_jobs",
  publicationImpacts: "publication_impacts",
  frozenGenerations: "frozen_generations",
  resourceOperations: "resource_operations",
  deletionIntents: "deletion_intents",
  uploadSessions: "upload_sessions",
  cleanupObjects: "cleanup_objects",
  maintenanceCandidateGenerations: "maintenance_candidate_generations"
};

const optionalQueryMarkers: Partial<Record<WorkKey, string>> = {
  knowledgeBaseMaintenanceRequests: "knowledge_base_index_maintenance_requests",
  projectionRepairs: "active_projection_repairs",
  lexicalRebuilds: "active_lexical_rebuilds",
  projectionCompactions: "projection_compaction_jobs"
};

function rawRow() {
  return {
    source_files: 0,
    dispatch_markers: 0,
    role_jobs: 0,
    publication_impacts: 0,
    frozen_generations: 0,
    resource_operations: 0,
    deletion_intents: 0,
    upload_sessions: 0,
    cleanup_objects: 0,
    maintenance_candidate_generations: 0,
    capped: false
  };
}
