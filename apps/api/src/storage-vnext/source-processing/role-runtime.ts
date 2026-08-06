type SourceRoleSettings = {
  sourceFileConcurrency: number;
  claimBatchSize: number;
  pollIntervalMs: number;
  lockTtlSeconds: number;
  jobMaxAttempts: number;
  jobRetryDelayMs: number;
  completedJobRetentionDays: number;
};

type SourceWorker = {
  runOnce(input: {
    owner: string;
    limit: number;
    leaseExpiresAt: string;
    signal?: AbortSignal;
  }): Promise<{ claimed: number; completed: number; retried: number; terminal: number }>;
};

export function createStorageVnextSourceRoleRuntime<
  TSettings extends SourceRoleSettings
>(input: {
  owner: string;
  clock: () => string;
  getSettings(): Promise<TSettings>;
  createWorker(settings: TSettings): SourceWorker;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  if (!input.owner) throw roleRuntimeError("invalid_owner");
  const wait = input.wait ?? waitForPoll;
  return {
    async run(signal: AbortSignal): Promise<void> {
      while (!signal.aborted) {
        const settings = await input.getSettings();
        validateSettings(settings);
        const worker = input.createWorker(settings);
        const outcome = await worker.runOnce({
          owner: input.owner,
          limit: Math.min(settings.claimBatchSize, settings.sourceFileConcurrency),
          leaseExpiresAt: addSeconds(input.clock(), settings.lockTtlSeconds),
          signal
        });
        if (!signal.aborted && outcome.claimed === 0) {
          await wait(settings.pollIntervalMs, signal);
        }
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

function validateSettings(settings: SourceRoleSettings): void {
  const integerValues = [
    settings.sourceFileConcurrency,
    settings.claimBatchSize,
    settings.pollIntervalMs,
    settings.lockTtlSeconds,
    settings.jobMaxAttempts,
    settings.jobRetryDelayMs,
    settings.completedJobRetentionDays
  ];
  if (
    integerValues.some((value) => !Number.isSafeInteger(value) || value < 1)
    || settings.claimBatchSize < settings.sourceFileConcurrency
  ) throw roleRuntimeError("invalid_settings");
}

function addSeconds(timestamp: string, seconds: number): string {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw roleRuntimeError("invalid_clock");
  return new Date(milliseconds + seconds * 1_000).toISOString();
}

function roleRuntimeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Storage vNext source role runtime error: ${code}`), { code });
}
