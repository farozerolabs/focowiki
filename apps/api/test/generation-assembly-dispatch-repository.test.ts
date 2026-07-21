import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import {
  createPostgresGenerationAssemblyDispatchRepository,
  isDeletedKnowledgeBaseDispatchRace
} from "../src/infrastructure/postgres/generation-assembly-dispatch-repository.js";

describe("generation assembly dispatch repository", () => {
  it("treats a deleted knowledge base foreign-key race as no dispatched work", async () => {
    const database = createRejectingDatabase({
      code: "23503",
      constraint_name: "role_jobs_knowledge_base_id_fkey"
    });
    const repository = createPostgresGenerationAssemblyDispatchRepository(database);

    await expect(repository.dispatchPending({
      now: "2026-07-21T09:00:00.000Z",
      limit: 10
    })).resolves.toBe(0);
  });

  it("does not hide unrelated database failures", async () => {
    const error = {
      code: "23503",
      constraint_name: "role_jobs_source_file_id_fkey"
    };
    const repository = createPostgresGenerationAssemblyDispatchRepository(
      createRejectingDatabase(error)
    );

    await expect(repository.dispatchPending({
      now: "2026-07-21T09:00:00.000Z",
      limit: 10
    })).rejects.toBe(error);
  });

  it("recognizes only the knowledge-base deletion race", () => {
    expect(isDeletedKnowledgeBaseDispatchRace(null)).toBe(false);
    expect(isDeletedKnowledgeBaseDispatchRace({ code: "23503" })).toBe(false);
    expect(isDeletedKnowledgeBaseDispatchRace({
      code: "23503",
      constraint_name: "role_jobs_knowledge_base_id_fkey"
    })).toBe(true);
  });
});

function createRejectingDatabase(error: unknown): DatabaseClient {
  return (async () => {
    throw error;
  }) as unknown as DatabaseClient;
}
