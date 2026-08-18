export async function waitForResourceRevision({
  expectedRevision,
  read,
  wait = sleep,
  intervalMs = 500,
  maximumAttempts = 600
}) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("Expected resource revision is invalid");
  }
  if (
    typeof read !== "function"
    || typeof wait !== "function"
    || !Number.isSafeInteger(intervalMs)
    || intervalMs < 1
    || !Number.isSafeInteger(maximumAttempts)
    || maximumAttempts < 1
  ) {
    throw new Error("Resource revision wait policy is invalid");
  }
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const resource = await read();
    if (resource?.resourceRevision === expectedRevision) return resource;
    if (attempt + 1 < maximumAttempts) await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for resource revision ${expectedRevision}.`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
