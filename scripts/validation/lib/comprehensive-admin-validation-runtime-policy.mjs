export function createAdminValidationRuntimePolicy(settings) {
  if (
    !settings?.publication
    || typeof settings.publication !== "object"
    || !settings?.worker
    || typeof settings.worker !== "object"
  ) {
    throw new Error("Admin validation runtime settings are incomplete");
  }
  const original = {
    publication: structuredClone(settings.publication),
    worker: structuredClone(settings.worker)
  };
  return {
    original,
    validation: {
      publication: {
        ...original.publication,
        intervalSeconds: 5
      },
      worker: {
        ...original.worker,
        jobRetryDelayMs: 100,
        hardDeleteRetryDelayMs: 100
      }
    }
  };
}
