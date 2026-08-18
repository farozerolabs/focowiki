const DAY_MILLISECONDS = 86_400_000;

export type DocumentRetentionPort = {
  uploads: {
    expireSessions(input: {
      expiredBefore: string;
      limit: number;
    }): Promise<number>;
  };
  jobs: {
    deleteRetained(input: {
      terminalBefore: string;
      limit: number;
    }): Promise<number>;
  };
  operationTombstones: {
    deleteExpired(input: {
      expiredBefore: string;
      limit: number;
    }): Promise<number>;
  };
};

export function createDocumentRetention(input: DocumentRetentionPort) {
  return {
    async run(request: {
      now: string;
      retentionDays: number;
      limit: number;
    }): Promise<{
      expiredUploadSessionCount: number;
      deletedDocumentJobCount: number;
      deletedOperationTombstoneCount: number;
    }> {
      const now = timestamp(request.now);
      assertPositiveInteger(request.retentionDays, "retentionDays", 3_650);
      assertPositiveInteger(request.limit, "limit", 1_000);
      const terminalBefore = new Date(
        Date.parse(now) - request.retentionDays * DAY_MILLISECONDS
      ).toISOString();
      const [uploads, jobs, operationTombstones] = await Promise.allSettled([
        input.uploads.expireSessions({
          expiredBefore: now,
          limit: request.limit
        }),
        input.jobs.deleteRetained({
          terminalBefore,
          limit: request.limit
        }),
        input.operationTombstones.deleteExpired({
          expiredBefore: now,
          limit: request.limit
        })
      ]);
      const failures = [uploads, jobs, operationTombstones]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 1) {
        throw new AggregateError(failures, "Document retention owners failed");
      }
      if (failures[0]) throw failures[0];
      return {
        expiredUploadSessionCount: count(fulfilledValue(uploads)),
        deletedDocumentJobCount: count(fulfilledValue(jobs)),
        deletedOperationTombstoneCount: count(fulfilledValue(operationTombstones))
      };
    }
  };
}

function fulfilledValue(result: PromiseSettledResult<number>): number {
  if (result.status !== "fulfilled") {
    throw new Error("Document retention result is unavailable");
  }
  return result.value;
}

function timestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Document retention timestamp is invalid");
  }
  return new Date(milliseconds).toISOString();
}

function assertPositiveInteger(value: number, field: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Document retention ${field} is invalid`);
  }
}

function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Document retention result count is invalid");
  }
  return value;
}
