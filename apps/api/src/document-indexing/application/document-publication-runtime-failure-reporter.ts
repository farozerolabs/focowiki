export type DocumentPublicationRuntimeDiagnostic = Readonly<{
  event: "failed" | "recovered";
  errorCode: string;
  failureCount: number;
  suppressedFailureCount: number;
  durationMs: number;
}>;

export function createDocumentPublicationRuntimeFailureReporter(input: {
  now?: () => number;
  reportIntervalMs?: number;
  emit(event: DocumentPublicationRuntimeDiagnostic): void;
}) {
  const now = input.now ?? Date.now;
  const reportIntervalMs = input.reportIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(reportIntervalMs) || reportIntervalMs < 1) {
    throw new Error("Publication runtime report interval is invalid");
  }
  let failure: {
    errorCode: string;
    startedAt: number;
    lastReportedAt: number;
    failureCount: number;
    reportedFailureCount: number;
  } | null = null;

  return {
    failed(errorCode: string): void {
      const observedAt = now();
      if (!failure || failure.errorCode !== errorCode) {
        failure = {
          errorCode,
          startedAt: observedAt,
          lastReportedAt: observedAt,
          failureCount: 0,
          reportedFailureCount: 0
        };
      }
      failure.failureCount += 1;
      if (failure.failureCount !== 1
        && observedAt - failure.lastReportedAt < reportIntervalMs) return;
      emit("failed", observedAt);
    },
    recovered(): void {
      if (!failure) return;
      const observedAt = now();
      input.emit({
        event: "recovered",
        errorCode: failure.errorCode,
        failureCount: failure.failureCount,
        suppressedFailureCount:
          failure.failureCount - failure.reportedFailureCount,
        durationMs: elapsed(failure.startedAt, observedAt)
      });
      failure = null;
    }
  };

  function emit(event: "failed", observedAt: number): void {
    if (!failure) return;
    input.emit({
      event,
      errorCode: failure.errorCode,
      failureCount: failure.failureCount,
      suppressedFailureCount:
        failure.failureCount - failure.reportedFailureCount - 1,
      durationMs: elapsed(failure.startedAt, observedAt)
    });
    failure.lastReportedAt = observedAt;
    failure.reportedFailureCount = failure.failureCount;
  }
}

function elapsed(startedAt: number, observedAt: number): number {
  return Math.max(0, Math.round(observedAt - startedAt));
}
