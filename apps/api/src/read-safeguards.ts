export async function readNonCritical<T>(input: {
  timeoutMs: number;
  fallback: T;
  operation: () => Promise<T>;
}): Promise<T> {
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const operation = input.operation().catch(() => input.fallback);
  const timeoutPromise = new Promise<T>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      resolve(input.fallback);
    }, input.timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }

    if (timedOut) {
      operation.catch(() => input.fallback);
    }
  }
}
