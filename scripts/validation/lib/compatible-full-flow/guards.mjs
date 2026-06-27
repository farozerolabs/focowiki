const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "postgres",
  "redis",
  "api",
  "admin",
  "worker"
]);

const DESTRUCTIVE_ENV_FLAGS = [
  "FOCOWIKI_VALIDATION_DROP_DATABASE",
  "FOCOWIKI_VALIDATION_RESET_DATABASE",
  "FOCOWIKI_VALIDATION_FLUSH_REDIS",
  "FOCOWIKI_VALIDATION_WIPE_S3",
  "FOCOWIKI_VALIDATION_DELETE_ALL_KNOWLEDGE_BASES",
  "FOCOWIKI_VALIDATION_DELETE_ALL_RELEASES",
  "FOCOWIKI_VALIDATION_DELETE_ALL_TASKS"
];

export function assertNonDestructiveValidationEnv(env = process.env) {
  const enabled = DESTRUCTIVE_ENV_FLAGS.filter((key) => readBoolean(env[key], false));

  if (enabled.length > 0) {
    throw new Error(
      `Compatible validation refuses destructive flags: ${enabled.join(", ")}`
    );
  }
}

export function assertCompatiblePassEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("Compatible validation evidence is required before local clean-room reset.");
  }

  if (evidence.kind !== "compatible-full-flow" || evidence.mode !== "compatible" || evidence.ok !== true) {
    throw new Error("Local clean-room reset requires a passed compatible full-flow evidence file.");
  }
}

export function assertLocalCleanRoomGuard(config, evidence) {
  assertCompatiblePassEvidence(evidence);

  if (!readBoolean(config.env.FOCOWIKI_VALIDATION_ALLOW_LOCAL_RESET, false)) {
    throw new Error("FOCOWIKI_VALIDATION_ALLOW_LOCAL_RESET=true is required for local clean-room reset.");
  }

  const runtimeLabel = String(config.env.APP_ENV ?? "").trim().toLowerCase();

  if (runtimeLabel === "production") {
    throw new Error("Local clean-room reset refuses APP_ENV=production.");
  }

  const originFields = [
    ["ADMIN_PUBLIC_ORIGIN", config.env.ADMIN_PUBLIC_ORIGIN],
    ["ADMIN_API_PUBLIC_ORIGIN", config.env.ADMIN_API_PUBLIC_ORIGIN],
    ["PUBLIC_BASE_URL", config.env.PUBLIC_BASE_URL],
    ["PUBLIC_OPENAPI_PUBLIC_ORIGIN", config.env.PUBLIC_OPENAPI_PUBLIC_ORIGIN]
  ];
  const remoteOrigins = originFields.filter(([, value]) => value && !isLocalUrl(value));

  if (remoteOrigins.length > 0) {
    throw new Error(
      `Local clean-room reset refuses remote origins: ${remoteOrigins.map(([key]) => key).join(", ")}`
    );
  }

  assertLocalConnectionUrl("DATABASE_URL", config.env.DATABASE_URL);
  assertLocalConnectionUrl("REDIS_URL", config.env.REDIS_URL);

  if (
    config.env.S3_ENDPOINT &&
    !isLocalUrl(config.env.S3_ENDPOINT) &&
    !readBoolean(config.env.FOCOWIKI_VALIDATION_ALLOW_REMOTE_TEST_S3_RESET, false)
  ) {
    throw new Error(
      "Local clean-room reset refuses non-local S3_ENDPOINT unless FOCOWIKI_VALIDATION_ALLOW_REMOTE_TEST_S3_RESET=true."
    );
  }

  if (isProductionLikeLabel(config.env.S3_PREFIX)) {
    throw new Error("Local clean-room reset refuses production-like S3_PREFIX.");
  }
}

export function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return isLocalHost(url.hostname);
  } catch {
    return false;
  }
}

export function isLocalConnectionUrl(value) {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return isLocalHost(url.hostname);
  } catch {
    return false;
  }
}

function assertLocalConnectionUrl(key, value) {
  if (!isLocalConnectionUrl(value)) {
    throw new Error(`Local clean-room reset refuses non-local ${key}.`);
  }
}

function isLocalHost(hostname) {
  const normalized = String(hostname ?? "").trim().toLowerCase();
  return LOCAL_HOSTS.has(normalized) || normalized.endsWith(".local");
}

function isProductionLikeLabel(value) {
  return /\b(prod|production|live|shared)\b/i.test(String(value ?? ""));
}

function readBoolean(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  return /^(1|true|yes|on)$/i.test(String(value).trim());
}
