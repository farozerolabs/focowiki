type PublicationRoleSettings = {
  mode: "batch" | "manual" | "per_file";
  roleConcurrency: number;
  claimBatchSize: number;
  pollIntervalMs: number;
  lockTtlSeconds: number;
  jobMaxAttempts: number;
  jobRetryDelayMs: number;
  completedJobRetentionDays: number;
};

type PublicationWorker = {
  runOnce(input: {
    owner: string;
    limit: number;
    leaseExpiresAt: string;
    signal?: AbortSignal;
  }): Promise<{ claimed: number; completed: number; retried: number; terminal: number }>;
};

export function createStorageVnextPublicationRoleRuntime<
  TSettings extends PublicationRoleSettings
>(input: {
  owner: string;
  clock: () => string;
  getSettings(): Promise<TSettings>;
  recoverStale(input: {
    expiredBefore: string;
    retryAt: string;
    limit: number;
  }): Promise<number>;
  createWorker(settings: TSettings): PublicationWorker;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  if (!input.owner) throw roleRuntimeError("invalid_owner");
  const wait = input.wait ?? waitForPoll;
  return {
    async run(signal: AbortSignal): Promise<void> {
      while (!signal.aborted) {
        const settings = await input.getSettings();
        validateSettings(settings);
        if (settings.mode !== "manual") {
          const recoveredAt = input.clock();
          const limit = Math.min(settings.claimBatchSize, settings.roleConcurrency);
          await input.recoverStale({
            expiredBefore: recoveredAt,
            retryAt: recoveredAt,
            limit
          });
          const worker = input.createWorker(settings);
          await worker.runOnce({
            owner: input.owner,
            limit,
            leaseExpiresAt: addSeconds(input.clock(), settings.lockTtlSeconds),
            signal
          });
        }
        if (!signal.aborted) await wait(settings.pollIntervalMs, signal);
      }
    }
  };
}

async function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function validateSettings(settings: PublicationRoleSettings): void {
  if (!["batch", "manual", "per_file"].includes(settings.mode)) {
    throw roleRuntimeError("invalid_settings");
  }
  const integerValues = [
    settings.roleConcurrency,
    settings.claimBatchSize,
    settings.pollIntervalMs,
    settings.lockTtlSeconds,
    settings.jobMaxAttempts,
    settings.jobRetryDelayMs,
    settings.completedJobRetentionDays
  ];
  if (
    integerValues.some((value) => !Number.isSafeInteger(value) || value < 1)
    || settings.claimBatchSize < settings.roleConcurrency
  ) throw roleRuntimeError("invalid_settings");
}

function addSeconds(timestamp: string, seconds: number): string {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw roleRuntimeError("invalid_clock");
  return new Date(milliseconds + seconds * 1_000).toISOString();
}

function roleRuntimeError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext publication role runtime error: ${code}`),
    { code }
  );
}
