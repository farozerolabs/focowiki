const WRITE_CAPABLE_SERVICES = [
  "api",
  "source-worker",
  "publication-worker",
  "maintenance-worker",
  "migrate",
  "meilisearch-init"
];

const COMPOSE_PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const POSTGRES_DATABASE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

export function resolveStorageVnextPostgresDatabase(value) {
  const database = typeof value === "string" ? value.trim() : "";
  if (!POSTGRES_DATABASE_PATTERN.test(database)) {
    throw new Error("PostgreSQL database name is invalid");
  }
  return database;
}

export function createComposeArguments(input) {
  if (
    input.projectName !== undefined
    && !COMPOSE_PROJECT_NAME_PATTERN.test(input.projectName)
  ) {
    throw new Error("Compose project name is invalid");
  }
  return [
    "compose",
    ...(input.projectName ? ["--project-name", input.projectName] : []),
    "--env-file",
    input.envFile,
    "-f",
    input.composeFile
  ];
}

export function assertNoActiveWriters(runningServices) {
  const running = new Set(runningServices);
  const activeWriters = WRITE_CAPABLE_SERVICES.filter((service) => running.has(service));
  if (activeWriters.length > 0) {
    throw new Error(
      `Backup requires write-capable services to be stopped: ${activeWriters.join(", ")}`
    );
  }
}

export function createAuthorityObjectSql() {
  return `
WITH authoritative_object_ids AS (
  SELECT DISTINCT owner.object_id
  FROM focowiki.object_owners AS owner
)
SELECT json_build_object(
  'objectId', registration.object_id,
  'storageKey', registration.storage_key,
  'checksumSha256', registration.checksum_sha256,
  'byteCount', registration.byte_count,
  'contentType', registration.content_type,
  'objectFormat', registration.object_format
)::text
FROM authoritative_object_ids AS authority
JOIN focowiki.object_registrations AS registration
  ON registration.object_id = authority.object_id
WHERE registration.state = 'verified'
ORDER BY registration.object_id;
`.trim();
}

export function createRuntimeSettingsSql() {
  return `
SELECT json_build_object(
  'publicId', revision.public_id,
  'checksumSha256', revision.checksum_sha256,
  'settingsValues', revision.settings_values,
  'createdAt', revision.created_at,
  'isCurrent', (current_pointer.revision_public_id IS NOT NULL)
)::text
FROM focowiki.runtime_setting_revisions AS revision
LEFT JOIN focowiki.runtime_setting_current AS current_pointer
  ON current_pointer.revision_public_id = revision.public_id
ORDER BY revision.created_at, revision.public_id;
`.trim();
}

export function createBackupManifest(input) {
  return {
    format: "focowiki-storage-vnext-backup-v1",
    backupId: input.backupId,
    createdAt: input.createdAt,
    postgres: {
      dump: input.postgresDump,
      format: "custom",
      includesCurrentFacts: true,
      includesRuntimeSettings: true,
      runtimeSettingsExport: input.runtimeSettingsExport
    },
    s3: {
      bucket: input.s3.bucket,
      prefix: input.s3.prefix,
      includesAuthorityObjects: true,
      includesVersionInventory: true,
      authorityObjectCount: input.s3.authorityObjectCount,
      authorityByteCount: input.s3.authorityByteCount,
      inventory: input.s3.inventory,
      authorityManifest: "s3/authority-objects.ndjson",
      versionInventory: "s3/s3-version-inventory.ndjson"
    },
    configuration: {
      env: "configuration/.env",
      compose: "configuration/docker-compose.yml"
    },
    runtimeSecrets: {
      directory: "runtime-secrets",
      included: true
    },
    redis: {
      mode: "rebuild",
      reason: "Redis contains cache and coordination state"
    },
    meilisearch: input.meilisearchSnapshot
      ? {
          mode: "snapshot",
          file: input.meilisearchSnapshot.file,
          sha256: input.meilisearchSnapshot.sha256
        }
      : {
          mode: "rebuild",
          reason: "Meilisearch projections are rebuilt from PostgreSQL and S3"
        },
    files: input.files
  };
}
