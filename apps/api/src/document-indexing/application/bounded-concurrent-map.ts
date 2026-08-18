export async function boundedConcurrentMap<TInput, TResult>(input: {
  values: readonly TInput[];
  concurrency: number;
  signal?: AbortSignal;
  map(value: TInput, index: number): Promise<TResult>;
}): Promise<TResult[]> {
  if (!Number.isSafeInteger(input.concurrency)
    || input.concurrency < 1 || input.concurrency > 1_000) {
    throw new Error("Bounded map concurrency is invalid");
  }
  if (input.signal?.aborted) throw input.signal.reason ?? abortError();
  const results = new Array<TResult>(input.values.length);
  let cursor = 0;
  const workers = Array.from({
    length: Math.min(input.concurrency, input.values.length)
  }, async () => {
    while (true) {
      if (input.signal?.aborted) throw input.signal.reason ?? abortError();
      const index = cursor;
      cursor += 1;
      if (index >= input.values.length) return;
      results[index] = await input.map(input.values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function abortError(): Error {
  return Object.assign(new Error("Bounded map was aborted"), {
    name: "AbortError"
  });
}
