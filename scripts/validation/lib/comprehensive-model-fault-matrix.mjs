export const MODEL_FAULT_ROLES = Object.freeze([
  "generation",
  "embedding",
  "reranker"
]);

export const MODEL_FAULT_TYPES = Object.freeze([
  "timeout",
  "rate_limit",
  "malformed_response",
  "retryable_failure",
  "non_retryable_failure",
  "cancellation",
  "pause"
]);

export const MODEL_FAULT_CASES = Object.freeze([
  modelFault("generation", "timeout",
    "apps/api/test/semantic-generation-model-completion.test.ts",
    "aborts and retries one timed-out %s request inside the same completion"),
  modelFault("generation", "rate_limit",
    "apps/api/test/semantic-generation-model-completion.test.ts",
    "retries one HTTP 429 generation failure"),
  modelFault("generation", "malformed_response",
    "apps/api/test/semantic-generation-model-completion.test.ts",
    "rejects invalid output locally without exposing provider payloads"),
  modelFault("generation", "retryable_failure",
    "apps/api/test/semantic-generation-model-completion.test.ts",
    "retries one retryable generation failure"),
  modelFault("generation", "non_retryable_failure",
    "apps/api/test/semantic-generation-model-completion.test.ts",
    "does not retry a non-retryable generation failure"),
  modelFault("generation", "cancellation",
    "apps/api/test/storage-vnext-source-model-adapter.test.ts",
    "stops before model or graph work when the request is already aborted"),
  modelFault("generation", "pause",
    "apps/api/test/runtime-settings.test.ts",
    "creates a model without exposing the raw key and blocks deleting a running model"),
  modelFault("embedding", "timeout",
    "apps/api/test/openai-compatible-embedding-transport.test.ts",
    "maps an embedding transport deadline to timeout"),
  modelFault("embedding", "rate_limit",
    "apps/api/test/openai-compatible-embedding-transport.test.ts",
    "classifies embedding HTTP 429 as retryable rate limiting"),
  modelFault("embedding", "malformed_response",
    "apps/api/test/openai-compatible-embedding-transport.test.ts",
    "rejects malformed vector responses with $code"),
  modelFault("embedding", "retryable_failure",
    "apps/api/test/embedding-gateway.test.ts",
    "retries only retryable failures within the configured bound"),
  modelFault("embedding", "non_retryable_failure",
    "apps/api/test/openai-compatible-embedding-transport.test.ts",
    "classifies embedding HTTP 400 as a non-retryable invalid request"),
  modelFault("embedding", "cancellation",
    "apps/api/test/openai-compatible-embedding-transport.test.ts",
    "maps caller embedding cancellation to aborted"),
  modelFault("embedding", "pause",
    "apps/api/test/embedding-configuration-service.test.ts",
    "guards pause and delete while referenced and supports pause-resume-delete lifecycle"),
  modelFault("reranker", "timeout",
    "apps/api/test/reranker-transport.test.ts",
    "maps a reranker transport deadline to timeout"),
  modelFault("reranker", "rate_limit",
    "apps/api/test/reranker-transport.test.ts",
    "classifies reranker HTTP 429 as retryable rate limiting"),
  modelFault("reranker", "malformed_response",
    "apps/api/test/reranker-transport.test.ts",
    "rejects a %s response atomically"),
  modelFault("reranker", "retryable_failure",
    "apps/api/test/reranker-transport.test.ts",
    "classifies reranker HTTP 503 as retryable unavailability"),
  modelFault("reranker", "non_retryable_failure",
    "apps/api/test/reranker-transport.test.ts",
    "classifies reranker HTTP 400 as a non-retryable invalid request"),
  modelFault("reranker", "cancellation",
    "apps/api/test/reranker-transport.test.ts",
    "maps caller reranker cancellation to aborted"),
  modelFault("reranker", "pause",
    "apps/api/test/reranker-gateway.test.ts",
    "fails open when the active configuration is %s")
]);

export function assertComprehensiveModelFaultCoverage(cases) {
  const expected = new Set(MODEL_FAULT_ROLES.flatMap((role) =>
    MODEL_FAULT_TYPES.map((faultType) => `${role}:${faultType}`)));
  const observed = new Set();
  for (const item of cases) {
    if (!MODEL_FAULT_ROLES.includes(item.role)) {
      throw new Error(`Unknown model fault role: ${item.id}.`);
    }
    if (!MODEL_FAULT_TYPES.includes(item.faultType)) {
      throw new Error(`Unknown model fault type: ${item.id}.`);
    }
    if (observed.has(item.id)) {
      throw new Error(`Duplicate model fault case: ${item.id}.`);
    }
    observed.add(item.id);
  }
  const missing = [...expected].filter((id) => !observed.has(id));
  const extra = [...observed].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0 || observed.size !== expected.size) {
    throw new Error("Comprehensive model fault coverage is incomplete.");
  }
  return {
    caseCount: observed.size,
    roles: [...MODEL_FAULT_ROLES],
    faultTypes: [...MODEL_FAULT_TYPES]
  };
}

function modelFault(role, faultType, file, testName) {
  return Object.freeze({
    id: `${role}:${faultType}`,
    role,
    faultType,
    file,
    testName
  });
}
