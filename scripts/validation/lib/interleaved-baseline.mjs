export function buildInterleavedBaselineSnapshot(input) {
  if (!input?.redactor || !input?.postgres || !input?.redis) {
    throw new Error("Interleaved baseline requires PostgreSQL, Redis, and redaction evidence.");
  }

  const postgres = input.redactor.redact({
    counts: input.postgres.counts,
    runtimeSettings: input.postgres.runtimeSettings,
    workers: input.postgres.workers,
    knowledgeBases: input.postgres.knowledgeBases
  });

  return {
    kind: "focowiki-interleaved-lifecycle-before-state",
    capturedAt: new Date().toISOString(),
    postgres,
    redis: input.redis,
    storage: {
      registeredObjects: input.postgres.immutableObjects ?? []
    },
    services: input.services ?? []
  };
}
