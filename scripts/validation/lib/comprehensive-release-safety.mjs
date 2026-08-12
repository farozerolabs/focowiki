import {
  createIsolatedValidationScope,
  validateIsolatedValidationScope
} from "./isolated-scope.mjs";

export const COMPREHENSIVE_COMPATIBILITY_BOUNDARIES = Object.freeze({
  allowedReasons: ["reproduced-compatible-defect-fix", "validation-tooling"],
  frozen: [
    "product-feature-surface",
    "ui-architecture",
    "ui-style",
    "ui-copy",
    "domain-specific-behavior",
    "public-route",
    "source-result-contract",
    "generated-logical-topology",
    "destructive-database-reset"
  ]
});

export const COMPREHENSIVE_BEFORE_STATE_FIELDS = Object.freeze([
  "git",
  "database",
  "redis",
  "s3",
  "search",
  "docker",
  "processes",
  "temporaryPaths"
]);

export const COMPREHENSIVE_INTERRUPTION_POLICY = Object.freeze({
  registerBeforeReference: true,
  resumeRequiresMatchingFingerprints: true,
  staleEvidence: "invalidate",
  compatibleExternalArtifacts: "reuse-after-verification",
  cleanupOrder: "reverse-dependency",
  unscopedCleanup: "reject"
});

export const COMPREHENSIVE_CLEANUP_ORDER = Object.freeze([
  "knowledgeBases",
  "apiKeys",
  "webhooks",
  "operations",
  "databaseRows",
  "redisState",
  "s3Objects",
  "providerIndexes",
  "providerDocuments",
  "vectorArtifacts",
  "leasesAndJobs",
  "temporaryRepositories",
  "stagingFiles",
  "rawReports",
  "processes",
  "containers",
  "validationImages",
  "networks",
  "volumes",
  "validationSecrets"
]);

export function assertCompatibilityChange({ reason, changedBoundaries = [] }) {
  if (!COMPREHENSIVE_COMPATIBILITY_BOUNDARIES.allowedReasons.includes(reason)) {
    throw new Error(`Unauthorized validation change reason: ${String(reason)}`);
  }

  const frozenChanges = changedBoundaries.filter((boundary) =>
    COMPREHENSIVE_COMPATIBILITY_BOUNDARIES.frozen.includes(boundary)
  );
  if (frozenChanges.length > 0) {
    throw new Error(`Frozen compatibility boundary changed: ${frozenChanges.join(", ")}`);
  }
}

export function createComprehensiveValidationScope({ runId, storagePrefix }) {
  const base = createIsolatedValidationScope({ runId, storagePrefix });
  const token = runId.replace(/^validation-/u, "");
  const scope = {
    ...base,
    dockerProjectName: `focowiki-clr-${token}`,
    searchIndexPrefix: `focowiki-clr-${token}`,
    vectorArtifactPrefix: `vectors/validation/${runId}/`,
    reportDirectory: `ReferenceDocs/validation/comprehensive-large-scale-release/${runId}`,
    temporaryNamePrefix: `focowiki-clr-${token}`
  };

  validateComprehensiveValidationScope(scope);
  return scope;
}

export function validateComprehensiveValidationScope(scope) {
  validateIsolatedValidationScope(scope);
  const token = scope.runId.replace(/^validation-/u, "");
  const required = {
    dockerProjectName: token,
    searchIndexPrefix: token,
    vectorArtifactPrefix: scope.runId,
    reportDirectory: scope.runId,
    temporaryNamePrefix: token
  };

  for (const [field, fragment] of Object.entries(required)) {
    const value = String(scope[field] ?? "");
    if (!value || !value.includes(fragment) || /(?:^|[-_/:])(prod|production|main|shared)(?:$|[-_/:])/iu.test(value)) {
      throw new Error(`Comprehensive validation scope ${field} is unsafe`);
    }
  }

  if (!scope.reportDirectory.startsWith("ReferenceDocs/validation/comprehensive-large-scale-release/")) {
    throw new Error("Comprehensive validation report directory is unsafe");
  }
}

export function assertNoScopeCollisions(scope, beforeState) {
  validateComprehensiveValidationScope(scope);
  const namespaces = beforeState?.namespaces;
  if (!Array.isArray(namespaces)) {
    throw new Error("Before-state namespace inventory is unresolved");
  }
  const targets = [
    scope.databaseName,
    scope.redisPrefix,
    scope.storagePrefix,
    scope.dockerProjectName,
    scope.searchIndexPrefix,
    scope.vectorArtifactPrefix,
    scope.reportDirectory,
    scope.temporaryNamePrefix
  ];
  const collisions = targets.filter((target) => namespaces.includes(target));
  if (collisions.length > 0) {
    throw new Error(`Validation namespace collision: ${collisions.join(", ")}`);
  }
}

export function buildOwnedCleanupPlan(scope, resources) {
  validateComprehensiveValidationScope(scope);
  if (!Array.isArray(resources)) {
    throw new Error("Cleanup resources are unresolved");
  }
  const order = new Map(COMPREHENSIVE_CLEANUP_ORDER.map((kind, index) => [kind, index]));
  const seen = new Set();

  return resources.map((resource) => {
    if (!order.has(resource.kind)) {
      throw new Error(`Unknown cleanup resource kind: ${String(resource.kind)}`);
    }
    if (!String(resource.id ?? "").includes(scope.runId)) {
      throw new Error(`Cleanup resource is not owned by ${scope.runId}`);
    }
    const identity = `${resource.kind}:${resource.id}`;
    if (seen.has(identity)) {
      throw new Error(`Duplicate cleanup resource: ${identity}`);
    }
    seen.add(identity);
    return { kind: resource.kind, id: resource.id };
  }).sort((left, right) => order.get(left.kind) - order.get(right.kind));
}
