export async function requestWithRateLimitRetry({
  request,
  wait = sleep,
  maximumRetries = 4
}) {
  if (typeof request !== "function" || typeof wait !== "function") {
    throw new Error("Rate-limit retry requires request and wait functions");
  }
  if (!Number.isSafeInteger(maximumRetries) || maximumRetries < 0) {
    throw new Error("Rate-limit retry count is invalid");
  }

  for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
    const response = await request();
    if (response?.status !== 429) return response;
    if (attempt === maximumRetries) {
      throw new Error("Rate-limit retry budget exhausted");
    }
    await wait(retryAfterMilliseconds(response.retryAfter));
  }
  throw new Error("Rate-limit retry budget exhausted");
}

function retryAfterMilliseconds(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(100, Math.min(seconds * 1_000, 60_000));
  }
  const timestamp = Date.parse(value ?? "");
  if (Number.isFinite(timestamp)) {
    return Math.max(100, Math.min(timestamp - Date.now(), 60_000));
  }
  return 1_000;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
