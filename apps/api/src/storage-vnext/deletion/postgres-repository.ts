import type { DatabaseClient } from "../../db/client.js";
import { acceptStorageVnextDeletion } from "./postgres-acceptance.js";
import { deleteStorageVnextSourceTasks } from "./postgres-source-task.js";
import type { StorageVnextDeletionRepository } from "./ports.js";

export type StorageVnextDeletionRepositoryErrorCode =
  | "invalid_input"
  | "resource_missing"
  | "scope_conflict"
  | "revision_conflict"
  | "idempotency_conflict"
  | "deletion_conflict"
  | "database_error";

export class StorageVnextDeletionRepositoryError extends Error {
  public constructor(public readonly code: StorageVnextDeletionRepositoryErrorCode) {
    super(`Storage vNext deletion repository error: ${code}`);
    this.name = "StorageVnextDeletionRepositoryError";
  }
}

export function createPostgresStorageVnextDeletionRepository(
  sql: DatabaseClient
): StorageVnextDeletionRepository {
  return {
    async acceptDeletion(request) {
      validateRequestHash(request.requestHash);
      try {
        return await sql.begin((transaction) => acceptStorageVnextDeletion({
          transaction,
          request
        }));
      } catch (error) {
        throw mapRepositoryError(error);
      }
    },

    async deleteSourceTasks(request) {
      try {
        return await sql.begin((transaction) => deleteStorageVnextSourceTasks({
          transaction,
          request
        }));
      } catch (error) {
        throw mapRepositoryError(error);
      }
    }
  };
}

function validateRequestHash(requestHash: string): void {
  if (!/^[0-9a-f]{64}$/u.test(requestHash)) {
    throw new StorageVnextDeletionRepositoryError("invalid_input");
  }
}

function mapRepositoryError(error: unknown): Error {
  if (error instanceof StorageVnextDeletionRepositoryError) return error;
  const code = error && typeof error === "object" && "code" in error
    ? error.code
    : null;
  if (typeof code === "string" && [
    "invalid_input",
    "resource_missing",
    "scope_conflict",
    "revision_conflict",
    "idempotency_conflict",
    "deletion_conflict"
  ].includes(code)) {
    return new StorageVnextDeletionRepositoryError(
      code as StorageVnextDeletionRepositoryErrorCode
    );
  }
  if (code === "23505" && constraint(error) === "operation_idempotency_key") {
    return new StorageVnextDeletionRepositoryError("idempotency_conflict");
  }
  return error instanceof Error
    ? error
    : new StorageVnextDeletionRepositoryError("database_error");
}

function constraint(error: unknown): string | null {
  return error && typeof error === "object"
    && "constraint_name" in error && typeof error.constraint_name === "string"
    ? error.constraint_name
    : null;
}
