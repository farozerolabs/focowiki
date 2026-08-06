export type StorageVnextSearchProjectionRepositoryErrorCode =
  | "batch_conflict"
  | "candidate_exists"
  | "cleanup_conflict"
  | "invalid_input"
  | "invalid_state"
  | "projection_conflict"
  | "projection_not_found"
  | "task_conflict"
  | "validation_conflict";

export class StorageVnextSearchProjectionRepositoryError extends Error {
  public constructor(
    public readonly code: StorageVnextSearchProjectionRepositoryErrorCode
  ) {
    super(`Storage vNext search projection repository error: ${code}`);
    this.name = "StorageVnextSearchProjectionRepositoryError";
  }
}

export function storageVnextSearchRepositoryError(
  code: StorageVnextSearchProjectionRepositoryErrorCode
) {
  return new StorageVnextSearchProjectionRepositoryError(code);
}
