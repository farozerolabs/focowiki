import { describe, expect, it } from "vitest";
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
    expect(database.calls).toBe(1);
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
      cleanupObjects: 10
    });

    const snapshot = await inspectMigrationWork(database);
    expect(snapshot.total).toBe(54);
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
});

function fakeDatabase(overrides: Partial<Record<WorkKey, number>>) {
  let calls = 0;
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
    capped: false
  };
  for (const [key, value] of Object.entries(overrides)) {
    const column = columns[key as WorkKey];
    const bounded = Math.min(value, 1_000_000);
    row[column] = bounded as never;
    row.capped ||= value > bounded;
  }
  const tagged = async () => {
    calls += 1;
    return [row];
  };
  const database = tagged as unknown as DatabaseClient & { readonly calls: number };
  Object.defineProperty(database, "calls", { get: () => calls });
  return database;
}

type WorkKey =
  | "sourceFiles"
  | "dispatchMarkers"
  | "roleJobs"
  | "publicationImpacts"
  | "frozenGenerations"
  | "resourceOperations"
  | "deletionIntents"
  | "uploadSessions"
  | "cleanupObjects";

const columns: Record<WorkKey, keyof ReturnType<typeof rawRow>> = {
  sourceFiles: "source_files",
  dispatchMarkers: "dispatch_markers",
  roleJobs: "role_jobs",
  publicationImpacts: "publication_impacts",
  frozenGenerations: "frozen_generations",
  resourceOperations: "resource_operations",
  deletionIntents: "deletion_intents",
  uploadSessions: "upload_sessions",
  cleanupObjects: "cleanup_objects"
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
    capped: false
  };
}
