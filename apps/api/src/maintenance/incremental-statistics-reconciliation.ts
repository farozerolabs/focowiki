import type { IncrementalStatisticsRepository } from "../application/ports/incremental-statistics-repository.js";

export type IncrementalStatisticsReconciliationResult = {
  claimed: boolean;
  changed: boolean;
  failed: boolean;
};

export async function runIncrementalStatisticsReconciliationSlice(input: {
  repository: IncrementalStatisticsRepository;
  workerId: string;
  leaseToken: string;
  now: string;
  leaseExpiresAt: string;
  reconciledBefore: string;
}): Promise<IncrementalStatisticsReconciliationResult> {
  const claim = await input.repository.claimForReconciliation(input);
  if (!claim) return { claimed: false, changed: false, failed: false };
  try {
    const result = await input.repository.reconcile({ ...claim, reconciledAt: input.now });
    return { claimed: true, changed: result.changed, failed: false };
  } catch {
    await input.repository.release(claim).catch(() => undefined);
    return { claimed: true, changed: false, failed: true };
  }
}
