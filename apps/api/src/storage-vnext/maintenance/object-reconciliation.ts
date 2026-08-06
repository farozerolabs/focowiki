import {
  reconcileStorageVnextProviderInventoryPage,
  reconcileStorageVnextRegistrationPage
} from "../ownership/object-reconciliation.js";
import type { StorageVnextOwnershipReadPort } from "../ownership/ports.js";
import type { StorageVnextObjectInventory } from
  "../ownership/s3-object-inventory.js";

type ReconciliationCursor = {
  version: 1;
  stage: "provider" | "registration";
  cursor: string | null;
};

export function createStorageVnextMaintenanceObjectReconciliation(input: {
  enabled: boolean;
  provider: StorageVnextObjectInventory;
  registrations: Pick<
    StorageVnextOwnershipReadPort,
    "getRegistrationsByStorageKeys" | "getClosure" | "listRegistrations"
  >;
  limit: number;
  graceElapsedAt: string;
}) {
  validateInput(input.enabled, input.limit, input.graceElapsedAt);
  return {
    async runPage(request: { cursor: string | null }) {
      if (!input.enabled) {
        return {
          outcome: "phase_completed" as const,
          cursor: null,
          findings: [],
          completedDelta: 0,
          expectedCount: 0,
          processedBytesDelta: 0,
          batchOrdinalDelta: 0
        };
      }
      const cursor = decodeCursor(request.cursor) ?? {
        version: 1 as const,
        stage: "provider" as const,
        cursor: null
      };
      if (cursor.stage === "provider") {
        const result = await reconcileStorageVnextProviderInventoryPage({
          provider: input.provider,
          registrations: input.registrations,
          graceElapsedAt: input.graceElapsedAt,
          limit: input.limit,
          cursor: cursor.cursor
        });
        return {
          outcome: "progress" as const,
          cursor: result.nextCursor === null
            ? encodeCursor({ version: 1, stage: "registration", cursor: null })
            : encodeCursor({
                version: 1,
                stage: "provider",
                cursor: result.nextCursor
              }),
          findings: result.findings,
          completedDelta: result.findings.length,
          expectedCount: result.findings.length,
          processedBytesDelta: Buffer.byteLength(JSON.stringify(result.findings)),
          batchOrdinalDelta: 1
        };
      }
      const result = await reconcileStorageVnextRegistrationPage({
        provider: input.provider,
        registrations: input.registrations,
        limit: input.limit,
        cursor: cursor.cursor
      });
      const completed = result.nextCursor === null;
      return {
        outcome: completed ? "phase_completed" as const : "progress" as const,
        cursor: completed
          ? null
          : encodeCursor({
              version: 1,
              stage: "registration",
              cursor: result.nextCursor
            }),
        findings: result.findings,
        completedDelta: result.findings.length,
        expectedCount: result.findings.length,
        processedBytesDelta: Buffer.byteLength(JSON.stringify(result.findings)),
        batchOrdinalDelta: 1
      };
    }
  };
}

function encodeCursor(cursor: ReconciliationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): ReconciliationCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      decoded?.version === 1
      && (decoded.stage === "provider" || decoded.stage === "registration")
      && (decoded.cursor === null || typeof decoded.cursor === "string")
    ) return decoded as ReconciliationCursor;
  } catch {
    // Mapped to one stable input error below.
  }
  throw reconciliationError("invalid_cursor");
}

function validateInput(enabled: boolean, limit: number, graceElapsedAt: string): void {
  if (
    typeof enabled !== "boolean"
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 1_000
    || !Number.isFinite(Date.parse(graceElapsedAt))
  ) throw reconciliationError("invalid_configuration");
}

function reconciliationError(code: string): Error {
  return Object.assign(
    new Error(`Storage vNext maintenance reconciliation error: ${code}`),
    { code }
  );
}
