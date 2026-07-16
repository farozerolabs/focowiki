export type GeneratedContentReadMetrics = {
  metadataLookupMs: number;
  objectTransferMs: number | null;
  outcome: "found" | "not_found" | "failed";
};

export async function readGeneratedContentWithMetrics<TDescriptor, TContent>(input: {
  resolve: () => Promise<TDescriptor | null>;
  read: (descriptor: TDescriptor) => Promise<TContent | null>;
  now: () => number;
  onComplete: (metrics: GeneratedContentReadMetrics) => void;
}): Promise<{ descriptor: TDescriptor | null; content: TContent | null }> {
  const metadataStartedAt = input.now();
  let descriptor: TDescriptor | null;

  try {
    descriptor = await input.resolve();
  } catch (error) {
    input.onComplete({
      metadataLookupMs: elapsed(input.now(), metadataStartedAt),
      objectTransferMs: null,
      outcome: "failed"
    });
    throw error;
  }

  const metadataLookupMs = elapsed(input.now(), metadataStartedAt);

  if (!descriptor) {
    input.onComplete({
      metadataLookupMs,
      objectTransferMs: null,
      outcome: "not_found"
    });
    return { descriptor: null, content: null };
  }

  const transferStartedAt = input.now();

  try {
    const content = await input.read(descriptor);
    input.onComplete({
      metadataLookupMs,
      objectTransferMs: elapsed(input.now(), transferStartedAt),
      outcome: content === null ? "not_found" : "found"
    });
    return { descriptor, content };
  } catch (error) {
    input.onComplete({
      metadataLookupMs,
      objectTransferMs: elapsed(input.now(), transferStartedAt),
      outcome: "failed"
    });
    throw error;
  }
}

function elapsed(completedAt: number, startedAt: number): number {
  return Math.max(0, completedAt - startedAt);
}
