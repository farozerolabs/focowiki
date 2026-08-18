export const UNIFIED_BACKGROUND_WORK_CLASSES = [
  "mutation",
  "deletion",
  "maintenance",
  "orphan"
] as const;

export type UnifiedBackgroundWorkClass =
  (typeof UNIFIED_BACKGROUND_WORK_CLASSES)[number];

export type UnifiedBackgroundWork = {
  publicId: string;
  workClass: UnifiedBackgroundWorkClass;
};

export function createUnifiedBackgroundClaim(input: {
  schedule: readonly UnifiedBackgroundWorkClass[];
  sources: Record<UnifiedBackgroundWorkClass, (
    limit: number
  ) => Promise<readonly { publicId: string }[]>>;
}) {
  validateSchedule(input.schedule);
  let cursor = 0;

  return async (limit: number): Promise<readonly UnifiedBackgroundWork[]> => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw schedulerError("invalid_claim_limit");
    }
    const claimed: UnifiedBackgroundWork[] = [];
    const identities = new Set<string>();
    while (claimed.length < limit) {
      let found = false;
      for (let attempt = 0; attempt < input.schedule.length; attempt += 1) {
        const workClass = input.schedule[cursor]!;
        cursor = (cursor + 1) % input.schedule.length;
        const items = await input.sources[workClass](1);
        if (items.length > 1) throw schedulerError("source_exceeded_limit");
        const item = items[0];
        if (!item) continue;
        if (!item.publicId) throw schedulerError("invalid_durable_identity");
        if (identities.has(item.publicId)) {
          throw new Error("Unified worker claim returned a duplicate durable identity");
        }
        identities.add(item.publicId);
        claimed.push({ publicId: item.publicId, workClass });
        found = true;
        break;
      }
      if (!found) break;
    }
    return claimed;
  };
}

function validateSchedule(
  schedule: readonly UnifiedBackgroundWorkClass[]
): void {
  if (schedule.length < 1 || schedule.length > 100) {
    throw schedulerError("invalid_schedule");
  }
  const present = new Set(schedule);
  for (const workClass of UNIFIED_BACKGROUND_WORK_CLASSES) {
    if (!present.has(workClass)) throw schedulerError("incomplete_schedule");
  }
}

function schedulerError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Unified worker scheduler error: ${code}`), {
    code
  });
}
