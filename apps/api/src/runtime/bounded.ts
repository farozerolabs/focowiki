export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type CursorPageRequest = {
  cursor: string | null;
  limit: number;
};

export async function* iterateCursorPages<T>(options: {
  pageSize: number;
  fetchPage: (request: CursorPageRequest) => Promise<CursorPage<T>>;
}): AsyncGenerator<T> {
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize <= 0) {
    throw new Error("Page size must be a positive integer");
  }

  let cursor: string | null = null;

  do {
    const page = await options.fetchPage({
      cursor,
      limit: options.pageSize
    });

    for (const item of page.items) {
      yield item;
    }

    cursor = page.nextCursor;
  } while (cursor);
}

export async function mapWithConcurrency<T, R>(
  items: Iterable<T>,
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("Concurrency must be a positive integer");
  }

  const pending = Array.from(items).map((item, index) => ({ item, index }));
  const results: R[] = [];
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (pending.length > 0) {
      const next = pending.shift();

      if (!next) {
        return;
      }

      results[next.index] = await worker(next.item);
    }
  });

  await Promise.all(workers);
  return results;
}
