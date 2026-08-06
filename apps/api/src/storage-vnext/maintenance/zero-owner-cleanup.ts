import type { StorageVnextOwnershipReadPort } from "../ownership/ports.js";

type ZeroOwnerCleanupResult = {
  outcome: "completed" | "progress" | "retry";
  eligible: number;
  deleted: number;
  skippedOwned: number;
  purgedRegistrations: number;
  reasonCode: string | null;
};

export function createStorageVnextZeroOwnerCleanup(input: {
  registrations: Pick<StorageVnextOwnershipReadPort, "listZeroOwnerObjects">;
  objects: {
    deleteZeroOwner(objectId: string): Promise<{
      deletedVersions: number;
      deletedMarkers: number;
      abortedMultipartUploads: number;
    }>;
  };
  purgeDeletedRegistrations(input: { limit: number }): Promise<number>;
}) {
  return {
    async runBatch(request: {
      graceElapsedBefore: string;
      limit: number;
    }): Promise<ZeroOwnerCleanupResult> {
      validateRequest(request);
      const page = await input.registrations.listZeroOwnerObjects({
        graceElapsedBefore: request.graceElapsedBefore,
        limit: request.limit,
        cursor: null
      });
      let deleted = 0;
      let skippedOwned = 0;
      let reasonCode: string | null = null;
      for (const registration of page.items) {
        try {
          await input.objects.deleteZeroOwner(registration.objectId);
          deleted += 1;
        } catch (error) {
          if (hasCode(error, "owners_present")) {
            skippedOwned += 1;
            continue;
          }
          reasonCode = objectFailureReason(error);
          break;
        }
      }
      const purgedRegistrations = await input.purgeDeletedRegistrations({
        limit: request.limit
      });
      return {
        outcome: reasonCode
          ? "retry"
          : page.nextCursor === null
            ? "completed"
            : "progress",
        eligible: page.items.length,
        deleted,
        skippedOwned,
        purgedRegistrations,
        reasonCode
      };
    }
  };
}

function validateRequest(input: {
  graceElapsedBefore: string;
  limit: number;
}): void {
  if (
    !Number.isFinite(Date.parse(input.graceElapsedBefore))
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > 1_000
  ) throw cleanupError("invalid_input");
}

function objectFailureReason(error: unknown): string {
  if (hasCode(error, "provider_delete_failed")) {
    return "OBJECT_PROVIDER_DELETE_FAILED";
  }
  if (hasCode(error, "provider_residue")) return "OBJECT_PROVIDER_RESIDUE";
  return "OBJECT_PROVIDER_UNAVAILABLE";
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function cleanupError(code: string): Error {
  return Object.assign(new Error(`Storage vNext zero-owner cleanup error: ${code}`), {
    code
  });
}
