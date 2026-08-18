import { describe, expect, it } from "vitest";
import {
  recoverDocumentWork,
  type DocumentWorkRecoveryInput
} from "../src/document-indexing/domain/document-work-recovery.js";

describe("document work recovery decisions", () => {
  it.each([
    ["process_death", { leaseExpired: true }, "requeue"],
    ["lease_expiry", { leaseExpired: true }, "requeue"],
    ["duplicate_wakeup", { receiptCommitted: true }, "acknowledge"],
    ["duplicate_provider_ack", { receiptCommitted: true }, "acknowledge"],
    ["partial_bulk_failure", { retryableItems: 2 }, "retry_failed_items"],
    ["slow_graphrag_chunk", { leaseExpired: false }, "keep_running"],
    ["activation_conflict", { invalidatedOwners: 1 }, "recompute_invalidated_owners"],
    ["cleanup_retry", { retryable: true }, "requeue"],
    ["redis_loss", { postgresWorkExists: true }, "requeue"]
  ] as const)("recovers %s from PostgreSQL truth", (event, override, expected) => {
    expect(recoverDocumentWork(recoveryInput({ event, ...override }))).toBe(expected);
  });

  it("never treats Redis as the durable owner", () => {
    expect(recoverDocumentWork(recoveryInput({
      postgresWorkExists: false,
      redisWakeupExists: true
    }))).toBe("discard_wakeup");
  });
});

function recoveryInput(
  overrides: Partial<DocumentWorkRecoveryInput>
): DocumentWorkRecoveryInput {
  return {
    event: "process_death",
    postgresWorkExists: true,
    redisWakeupExists: false,
    receiptCommitted: false,
    leaseExpired: false,
    retryable: false,
    retryableItems: 0,
    invalidatedOwners: 0,
    ...overrides
  };
}
