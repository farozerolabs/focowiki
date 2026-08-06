export const FAULT_COMPONENTS = Object.freeze([
  "api",
  "worker",
  "redis",
  "s3",
  "meilisearch",
  "model"
]);

export const FAULT_TYPES = Object.freeze([
  "timeout",
  "refusal",
  "malformed_response",
  "task_failure",
  "process_restart",
  "database_conflict",
  "cancellation"
]);

export const FAULT_BOUNDARIES = Object.freeze([
  "pre_write",
  "post_write",
  "pre_activation",
  "post_activation"
]);

export const LIVE_FAULT_INJECTION_CASES = Object.freeze([
  liveFaultCase(
    "live-api-restart-pre-write",
    "api",
    "process_restart",
    "pre_write"
  ),
  liveFaultCase(
    "live-redis-refusal-post-write",
    "redis",
    "refusal",
    "post_write"
  ),
  liveFaultCase(
    "live-s3-refusal-pre-write",
    "s3",
    "refusal",
    "pre_write"
  ),
  liveFaultCase(
    "live-worker-restart-post-write",
    "worker",
    "process_restart",
    "post_write"
  ),
  liveFaultCase(
    "live-meilisearch-refusal-pre-activation",
    "meilisearch",
    "refusal",
    "pre_activation"
  )
]);

export const FAULT_INJECTION_CASES = Object.freeze([
  faultCase(
    "api-malformed-pre-write",
    "api",
    "malformed_response",
    "pre_write",
    "api-contract",
    "apps/api/test/runtime-settings.test.ts",
    "rejects empty and malformed setting documents without changing saved values"
  ),
  faultCase(
    "api-cancellation-pre-write",
    "api",
    "cancellation",
    "pre_write",
    "api-contract",
    "apps/api/test/storage-vnext-upload-lifecycle-contract.test.ts",
    "treats client disconnect as cancellation and closes the live session"
  ),
  faultCase(
    "api-timeout-post-write",
    "api",
    "timeout",
    "post_write",
    "api-contract",
    "apps/api/test/storage-vnext-upload-lifecycle-contract.test.ts",
    "terminalizes an upload timeout and schedules deterministic cleanup"
  ),
  faultCase(
    "api-restart-post-write",
    "api",
    "process_restart",
    "post_write",
    "api-repository",
    "apps/api/test/storage-vnext-workflow-audit-repository.integration.test.ts",
    "recovers one expired lease across worker and API restart without losing progress"
  ),
  faultCase(
    "redis-refusal-pre-write",
    "redis",
    "refusal",
    "pre_write",
    "api-contract",
    "apps/api/test/api-redis-runtime.test.ts",
    "continues without Redis when the API connection is unavailable"
  ),
  faultCase(
    "redis-timeout-post-write",
    "redis",
    "timeout",
    "post_write",
    "api-contract",
    "apps/api/test/api-redis-runtime.test.ts",
    "falls back to bounded reads while an established Redis connection is interrupted"
  ),
  faultCase(
    "redis-restart-post-activation",
    "redis",
    "process_restart",
    "post_activation",
    "api-contract",
    "apps/api/test/api-redis-runtime.test.ts",
    "recovers Redis-backed behavior after the connection becomes ready again"
  ),
  faultCase(
    "s3-timeout-pre-write",
    "s3",
    "timeout",
    "pre_write",
    "api-contract",
    "apps/api/test/storage-vnext-upload-body-writer.test.ts",
    "compensates an owned timed-out reservation without marking it verified"
  ),
  faultCase(
    "s3-database-conflict-post-write",
    "s3",
    "database_conflict",
    "post_write",
    "api-contract",
    "apps/api/test/storage-vnext-failed-write-compensation.test.ts",
    "compensates a database failure after provider verification"
  ),
  faultCase(
    "s3-restart-post-write",
    "s3",
    "process_restart",
    "post_write",
    "api-repository",
    "apps/api/test/storage-vnext-object-ownership.integration.test.ts",
    "recovers only unowned stale reservations after process termination"
  ),
  faultCase(
    "model-timeout-pre-write",
    "model",
    "timeout",
    "pre_write",
    "api-contract",
    "apps/api/test/storage-vnext-source-processing-contract.test.ts",
    "releases a retryable model timeout with a safe code and stable attempt identity"
  ),
  faultCase(
    "model-refusal-pre-write",
    "model",
    "refusal",
    "pre_write",
    "okf-contract",
    "packages/okf/test/model.test.ts",
    "returns safe warnings for refusal, incomplete response, invalid output, and provider errors"
  ),
  faultCase(
    "model-malformed-pre-write",
    "model",
    "malformed_response",
    "pre_write",
    "okf-contract",
    "packages/okf/test/model.test.ts",
    "records one safe warning after two failed attempts"
  ),
  faultCase(
    "model-cancellation-pre-write",
    "model",
    "cancellation",
    "pre_write",
    "api-contract",
    "apps/api/test/storage-vnext-source-model-adapter.test.ts",
    "stops before model or graph work when the request is already aborted"
  ),
  faultCase(
    "worker-cancellation-post-write",
    "worker",
    "cancellation",
    "post_write",
    "api-contract",
    "apps/api/test/storage-vnext-source-processing-contract.test.ts",
    "aborts the active request and releases durable work during role shutdown"
  ),
  faultCase(
    "worker-restart-post-write",
    "worker",
    "process_restart",
    "post_write",
    "api-repository",
    "apps/api/test/storage-vnext-workflow-audit-repository.integration.test.ts",
    "recovers one expired lease across worker and API restart without losing progress"
  ),
  faultCase(
    "worker-task-failure-pre-activation",
    "worker",
    "task_failure",
    "pre_activation",
    "api-contract",
    "apps/api/test/storage-vnext-publication-worker.test.ts",
    "releases a failed attempt for retry without terminating the candidate"
  ),
  faultCase(
    "worker-database-conflict-pre-activation",
    "worker",
    "database_conflict",
    "pre_activation",
    "api-contract",
    "apps/api/test/storage-vnext-publication-worker.test.ts",
    "keeps the role alive when concurrent terminal convergence owns the retry transition"
  ),
  faultCase(
    "worker-task-failure-post-activation",
    "worker",
    "task_failure",
    "post_activation",
    "api-contract",
    "apps/api/test/storage-vnext-publication-worker.test.ts",
    "releases a rollback-pending activation for retry without crashing the role"
  ),
  faultCase(
    "meilisearch-refusal-pre-activation",
    "meilisearch",
    "refusal",
    "pre_activation",
    "api-contract",
    "apps/api/test/meilisearch-transport.test.ts",
    "retries retryable failures and exposes only stable error details"
  ),
  faultCase(
    "meilisearch-malformed-pre-activation",
    "meilisearch",
    "malformed_response",
    "pre_activation",
    "api-contract",
    "apps/api/test/meilisearch-transport.test.ts",
    "fails safely when required pressure metrics are unavailable"
  ),
  faultCase(
    "meilisearch-task-failure-pre-activation",
    "meilisearch",
    "task_failure",
    "pre_activation",
    "api-contract",
    "apps/api/test/meilisearch-transport.test.ts",
    "maps task terminal states without treating enqueue as completion"
  ),
  faultCase(
    "meilisearch-timeout-pre-activation",
    "meilisearch",
    "timeout",
    "pre_activation",
    "api-contract",
    "apps/api/test/storage-vnext-search-candidate-lifecycle.test.ts",
    "stops polling at the configured bound and leaves the task resumable"
  ),
  faultCase(
    "meilisearch-restart-pre-activation",
    "meilisearch",
    "process_restart",
    "pre_activation",
    "api-contract",
    "apps/api/test/storage-vnext-search-candidate-lifecycle.test.ts",
    "recovers the accepted task by durable correlation after a crash window"
  ),
  faultCase(
    "worker-cancellation-pre-activation",
    "worker",
    "cancellation",
    "pre_activation",
    "api-contract",
    "apps/api/test/storage-vnext-publication-processor.test.ts",
    "stops at an aborted boundary before publishing generated artifacts"
  )
]);

export function assertStorageVnextFaultInjectionCoverage(cases) {
  const ids = new Set();
  const components = new Set();
  const faultTypes = new Set();
  const boundaries = new Set();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate fault case: ${item.id}`);
    ids.add(item.id);
    requireMember(item.component, FAULT_COMPONENTS, "component", item.id);
    requireMember(item.faultType, FAULT_TYPES, "fault type", item.id);
    requireMember(item.boundary, FAULT_BOUNDARIES, "boundary", item.id);
    if (!item.evidence?.file || !item.evidence?.testName || !item.evidence?.suite) {
      throw new Error(`Fault case has incomplete evidence: ${item.id}`);
    }
    components.add(item.component);
    faultTypes.add(item.faultType);
    boundaries.add(item.boundary);
  }
  requireCompleteDimension(components, FAULT_COMPONENTS, "components");
  requireCompleteDimension(faultTypes, FAULT_TYPES, "fault types");
  requireCompleteDimension(boundaries, FAULT_BOUNDARIES, "boundaries");
  return {
    caseCount: cases.length,
    components: [...FAULT_COMPONENTS],
    faultTypes: [...FAULT_TYPES],
    boundaries: [...FAULT_BOUNDARIES]
  };
}

export function faultInjectionTestFiles(cases) {
  return [...new Set(cases.map((item) => item.evidence.file))];
}

export function buildFaultInjectionSuites(cases) {
  const definitions = [
    {
      id: "api-contract",
      packageName: "@focowiki/api",
      requiresOwnedDatabase: false
    },
    {
      id: "okf-contract",
      packageName: "@focowiki/okf",
      requiresOwnedDatabase: false
    },
    {
      id: "api-repository",
      packageName: "@focowiki/api",
      requiresOwnedDatabase: true
    }
  ];
  return definitions.map((definition) => ({
    ...definition,
    files: [...new Set(cases
      .filter((item) => item.evidence.suite === definition.id)
      .map((item) => item.evidence.file))]
  })).filter((suite) => suite.files.length > 0);
}

function faultCase(id, component, faultType, boundary, suite, file, testName) {
  return Object.freeze({
    id,
    component,
    faultType,
    boundary,
    evidence: Object.freeze({ suite, file, testName })
  });
}

function liveFaultCase(id, component, faultType, boundary) {
  return Object.freeze({ id, component, faultType, boundary });
}

function requireMember(value, allowed, label, id) {
  if (!allowed.includes(value)) {
    throw new Error(`Unknown ${label} for ${id}: ${value}`);
  }
}

function requireCompleteDimension(actual, expected, label) {
  const missing = expected.filter((value) => !actual.has(value));
  if (missing.length > 0) {
    throw new Error(`Missing fault injection ${label}: ${missing.join(", ")}`);
  }
}
