import type {
  UnifiedBackgroundWork,
  UnifiedBackgroundWorkClass
} from "./unified-worker-scheduler.js";

export function createUnifiedMaintenanceLane(input: {
  schedule: Readonly<Record<UnifiedBackgroundWorkClass, number>>;
  run(workClass: UnifiedBackgroundWorkClass, signal: AbortSignal): Promise<void>;
  clock?: () => number;
}) {
  const clock = input.clock ?? Date.now;
  const due = new Map<UnifiedBackgroundWorkClass, number>();
  const sequence = new Map<UnifiedBackgroundWorkClass, number>();
  for (const [workClass, interval] of Object.entries(input.schedule)) {
    if (!Number.isSafeInteger(interval) || interval < 100 || interval > 86_400_000) {
      throw new Error(`Unified maintenance interval is invalid: ${workClass}`);
    }
    due.set(workClass as UnifiedBackgroundWorkClass, 0);
    sequence.set(workClass as UnifiedBackgroundWorkClass, 0);
  }

  return {
    async claim(limit: number): Promise<readonly UnifiedBackgroundWork[]> {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("Unified maintenance claim limit is invalid");
      }
      const now = clock();
      const claimed: UnifiedBackgroundWork[] = [];
      for (const workClass of Object.keys(input.schedule)
        .sort() as UnifiedBackgroundWorkClass[]) {
        if (claimed.length >= limit || now < (due.get(workClass) ?? 0)) continue;
        const next = (sequence.get(workClass) ?? 0) + 1;
        sequence.set(workClass, next);
        due.set(workClass, now + input.schedule[workClass]);
        claimed.push({
          publicId: `unified-${workClass}-${now}-${next}`,
          workClass
        });
      }
      return claimed;
    },
    async process(work: UnifiedBackgroundWork, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return;
      await input.run(work.workClass, signal);
    }
  };
}
