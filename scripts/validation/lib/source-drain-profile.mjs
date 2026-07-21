const CONCURRENCY_FIELDS = [
  "sourceFileConcurrency",
  "sourceObjectReadConcurrency",
  "graphQueryConcurrency",
  "databaseMutationConcurrency"
];

export function buildSourceDrainProfile({ sampleCount, workerReplicas, worker }) {
  if (!Number.isSafeInteger(workerReplicas) || workerReplicas <= 0) {
    throw new Error("Source drain worker replica count must be a positive integer.");
  }
  for (const field of CONCURRENCY_FIELDS) {
    if (!Number.isSafeInteger(worker?.[field]) || worker[field] <= 0) {
      throw new Error(`Source drain worker setting ${field} must be a positive integer.`);
    }
  }
  return {
    sampleCount,
    modelAssistance: "disabled",
    workerReplicas,
    sourceConcurrency: worker.sourceFileConcurrency,
    sourceObjectReadConcurrency: worker.sourceObjectReadConcurrency,
    graphQueryConcurrency: worker.graphQueryConcurrency,
    databaseMutationConcurrency: worker.databaseMutationConcurrency,
    timingBoundary: "first source start to last source completion after all files were accepted"
  };
}
