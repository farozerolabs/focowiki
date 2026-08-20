export const GENERATION_WORK_CLASSES = [
  "first_layer",
  "graphrag",
  "candidate_delta",
  "slow_retry"
] as const;

export type GenerationWorkClass = (typeof GENERATION_WORK_CLASSES)[number];

export function createWeightedGenerationQueue<TItem>(input: {
  weights: Record<GenerationWorkClass, number>;
}) {
  const queues = Object.fromEntries(GENERATION_WORK_CLASSES.map((kind) => [
    kind,
    [] as TItem[]
  ])) as Record<GenerationWorkClass, TItem[]>;
  const credits = Object.fromEntries(GENERATION_WORK_CLASSES.map((kind) => [
    kind,
    0
  ])) as Record<GenerationWorkClass, number>;
  let totalWeight = 0;
  for (const kind of GENERATION_WORK_CLASSES) {
    const weight = input.weights[kind];
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 100) {
      throw new Error("GENERATION_WEIGHT_INVALID");
    }
    totalWeight += weight;
  }
  return {
    enqueue(workClass: GenerationWorkClass, item: TItem): void {
      queues[workClass].push(item);
    },
    dequeue(
      canRun: (item: TItem) => boolean = () => true
    ): { workClass: GenerationWorkClass; item: TItem } | null {
      const available = GENERATION_WORK_CLASSES.filter(
        (kind) => queues[kind].some(canRun)
      );
      if (available.length === 0) return null;
      for (const kind of GENERATION_WORK_CLASSES) {
        credits[kind] = Math.min(
          totalWeight * 2,
          credits[kind] + input.weights[kind]
        );
      }
      const workClass = available.reduce((selected, kind) =>
        credits[kind] > credits[selected] ? kind : selected
      );
      credits[workClass] -= totalWeight;
      const index = queues[workClass].findIndex(canRun);
      return { workClass, item: queues[workClass].splice(index, 1)[0]! };
    },
    size(): number {
      return GENERATION_WORK_CLASSES.reduce(
        (total, kind) => total + queues[kind].length,
        0
      );
    }
  };
}
