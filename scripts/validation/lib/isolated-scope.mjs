const RUN_ID_PATTERN = /^validation-(\d{14})-([a-f0-9]{8})$/u;
const FORBIDDEN_SCOPE_WORDS = /(?:^|[/:_-])(prod|production|main|shared)(?:$|[/:_-])/iu;

export function createIsolatedValidationScope({ runId, storagePrefix }) {
  const match = RUN_ID_PATTERN.exec(runId);
  if (!match) throw new Error("Validation run ID must be unique and well formed");

  const normalizedStoragePrefix = normalizePrefix(storagePrefix);
  const scope = {
    runId,
    databaseName: `focowiki_validation_${match[1]}_${match[2]}`,
    redisPrefix: `focowiki:validation:${runId}:`,
    storagePrefix: `${normalizedStoragePrefix}/validation/${runId}/`,
    adminUsername: `validation-admin-${runId}`,
    openApiKeyName: `validation-key-${runId}`,
    knowledgeBasePrefix: `validation-${runId}`
  };

  validateIsolatedValidationScope(scope);
  return scope;
}

export function validateIsolatedValidationScope(scope) {
  if (!scope || !RUN_ID_PATTERN.test(scope.runId)) {
    throw new Error("Validation cleanup requires a unique run ID");
  }

  const requiredFragments = {
    databaseName: scope.runId.replace(/^validation-/u, "").replaceAll("-", "_"),
    redisPrefix: scope.runId,
    storagePrefix: `/validation/${scope.runId}/`,
    adminUsername: scope.runId,
    openApiKeyName: scope.runId,
    knowledgeBasePrefix: scope.runId
  };

  for (const [field, fragment] of Object.entries(requiredFragments)) {
    const value = String(scope[field] ?? "");
    if (!value || !value.includes(fragment) || FORBIDDEN_SCOPE_WORDS.test(value)) {
      throw new Error(`Validation cleanup scope ${field} is unsafe`);
    }
  }

  if (!scope.databaseName.startsWith("focowiki_validation_")) {
    throw new Error("Validation database must use the isolated database prefix");
  }
  if (!scope.redisPrefix.startsWith("focowiki:validation:")) {
    throw new Error("Validation Redis scope must use the isolated key prefix");
  }
}

function normalizePrefix(value) {
  const prefix = String(value ?? "").trim().replace(/^\/+|\/+$/gu, "");
  if (!prefix || FORBIDDEN_SCOPE_WORDS.test(prefix)) {
    throw new Error("Validation storage root must be explicit and non-production");
  }
  return prefix;
}
