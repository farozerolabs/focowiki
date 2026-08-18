export type DocumentWorkRecoveryEvent =
  | "process_death"
  | "lease_expiry"
  | "duplicate_wakeup"
  | "duplicate_provider_ack"
  | "partial_bulk_failure"
  | "slow_graphrag_chunk"
  | "activation_conflict"
  | "cleanup_retry"
  | "redis_loss";

export type DocumentWorkRecoveryInput = {
  event: DocumentWorkRecoveryEvent;
  postgresWorkExists: boolean;
  redisWakeupExists: boolean;
  receiptCommitted: boolean;
  leaseExpired: boolean;
  retryable: boolean;
  retryableItems: number;
  invalidatedOwners: number;
};

export type DocumentWorkRecoveryDecision =
  | "acknowledge"
  | "discard_wakeup"
  | "keep_running"
  | "recompute_invalidated_owners"
  | "requeue"
  | "retry_failed_items";

export function recoverDocumentWork(
  input: DocumentWorkRecoveryInput
): DocumentWorkRecoveryDecision {
  if (!input.postgresWorkExists) return "discard_wakeup";
  if (input.receiptCommitted) return "acknowledge";
  if (input.event === "partial_bulk_failure" && input.retryableItems > 0) {
    return "retry_failed_items";
  }
  if (input.event === "activation_conflict" && input.invalidatedOwners > 0) {
    return "recompute_invalidated_owners";
  }
  if (input.event === "slow_graphrag_chunk" && !input.leaseExpired) {
    return "keep_running";
  }
  if (
    input.leaseExpired
    || input.retryable
    || input.event === "redis_loss"
    || input.event === "process_death"
    || input.event === "lease_expiry"
  ) return "requeue";
  return "keep_running";
}
