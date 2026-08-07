import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createStorageVnextBackup } from "../../deployment/storage-vnext-backup.mjs";
import {
  createStorageVnextRestore,
  restoreAuthorityObjects
} from "../../deployment/storage-vnext-restore.mjs";
import {
  assertNoActiveWriters,
  createComposeArguments,
  resolveStorageVnextPostgresDatabase,
  createAuthorityObjectSql,
  createBackupManifest
} from "../../deployment/storage-vnext-backup-contract.mjs";

test("backup and restore require one explicit safe PostgreSQL database target", () => {
  assert.equal(
    resolveStorageVnextPostgresDatabase("focowiki_svnext_20260803t000000z_abcdef123456"),
    "focowiki_svnext_20260803t000000z_abcdef123456"
  );
  assert.throws(
    () => resolveStorageVnextPostgresDatabase("focowiki; DROP DATABASE postgres"),
    /database name/u
  );
});
import {
  backupAuthorityObjects,
  writeS3VersionInventory
} from "../../deployment/storage-vnext-s3-backup.mjs";

const rootDir = resolve(import.meta.dirname, "../../..");

test("backup refuses to run while any write-capable runtime role is active", () => {
  assert.throws(
    () => assertNoActiveWriters(["postgres", "api", "source-worker"]),
    /api, source-worker/u
  );
  assert.doesNotThrow(() => assertNoActiveWriters([
    "admin",
    "postgres",
    "redis",
    "meilisearch"
  ]));
});

test("backup and restore scope Compose commands to the requested project", () => {
  assert.deepEqual(createComposeArguments({
    projectName: "focowiki-svnext-r215-source",
    envFile: "/workspace/.env",
    composeFile: "/workspace/docker-compose.local.yml"
  }), [
    "compose",
    "--project-name",
    "focowiki-svnext-r215-source",
    "--env-file",
    "/workspace/.env",
    "-f",
    "/workspace/docker-compose.local.yml"
  ]);
  assert.throws(() => createComposeArguments({
    projectName: "../other-project",
    envFile: "/workspace/.env",
    composeFile: "/workspace/docker-compose.local.yml"
  }), /project name/u);
});

test("authority query selects every verified object with an explicit durable owner", () => {
  const sql = createAuthorityObjectSql();

  assert.match(
    sql,
    /SELECT DISTINCT owner\.object_id\s+FROM focowiki\.object_owners AS owner/u
  );
  assert.match(sql, /registration\.state = 'verified'/u);
  assert.doesNotMatch(
    sql,
    /owner\.release_root_public_id = snapshot\.release_root_public_id/u
  );
  assert.doesNotMatch(sql, /generation_projection_records|active_projection_records/u);
});

test("S3 version inventory streams every page, delete marker, and multipart upload", async () => {
  const lines = [];
  const requests = [];
  const client = {
    async send(command) {
      const name = command.constructor.name;
      requests.push({ name, input: command.input });
      if (name === "ListObjectVersionsCommand" && !command.input.KeyMarker) {
        return {
          Versions: [{ Key: "scope/source.md", VersionId: "v2", IsLatest: true, Size: 12 }],
          DeleteMarkers: [{ Key: "scope/old.md", VersionId: "d1", IsLatest: true }],
          IsTruncated: true,
          NextKeyMarker: "scope/source.md",
          NextVersionIdMarker: "v2"
        };
      }
      if (name === "ListObjectVersionsCommand") {
        return {
          Versions: [{ Key: "scope/source.md", VersionId: "v1", IsLatest: false, Size: 10 }],
          IsTruncated: false
        };
      }
      return {
        Uploads: [{ Key: "scope/pending.bin", UploadId: "upload-1", Initiated: new Date(0) }],
        IsTruncated: false
      };
    }
  };

  const summary = await writeS3VersionInventory({
    client,
    bucket: "backup-bucket",
    prefix: "scope/",
    write(record) {
      lines.push(record);
    }
  });

  assert.deepEqual(summary, {
    currentObjectCount: 1,
    currentBytes: 12,
    noncurrentVersionCount: 1,
    noncurrentBytes: 10,
    deleteMarkerCount: 1,
    multipartUploadCount: 1
  });
  assert.equal(lines.length, 4);
  assert.deepEqual(requests.map(({ name }) => name), [
    "ListObjectVersionsCommand",
    "ListObjectVersionsCommand",
    "ListMultipartUploadsCommand"
  ]);
  assert.equal(requests[1].input.KeyMarker, "scope/source.md");
});

test("S3 inventory falls back to current objects when version listing is unsupported", async () => {
  const lines = [];
  const requests = [];
  const client = {
    async send(command) {
      const name = command.constructor.name;
      requests.push(name);
      if (name === "ListObjectVersionsCommand") {
        throw Object.assign(new Error("ListObjectVersions not implemented"), {
          name: "NotImplemented",
          Code: "NotImplemented",
          $metadata: { httpStatusCode: 501 }
        });
      }
      if (name === "ListObjectsV2Command") {
        return {
          Contents: [{
            Key: "scope/source.md",
            Size: 12,
            ETag: '"etag"',
            LastModified: new Date(0)
          }],
          IsTruncated: false
        };
      }
      return { Uploads: [], IsTruncated: false };
    }
  };

  const summary = await writeS3VersionInventory({
    client,
    bucket: "backup-bucket",
    prefix: "scope/",
    write(record) {
      lines.push(record);
    }
  });

  assert.deepEqual(summary, {
    currentObjectCount: 1,
    currentBytes: 12,
    noncurrentVersionCount: 0,
    noncurrentBytes: 0,
    deleteMarkerCount: 0,
    multipartUploadCount: 0
  });
  assert.deepEqual(lines, [{
    kind: "version",
    key: "scope/source.md",
    versionId: null,
    isLatest: true,
    size: 12,
    etag: '"etag"',
    lastModified: new Date(0).toISOString(),
    storageClass: null
  }]);
  assert.deepEqual(requests, [
    "ListObjectVersionsCommand",
    "ListObjectsV2Command",
    "ListMultipartUploadsCommand"
  ]);
});

test("authority object backup streams bodies and verifies bytes and checksums", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "focowiki-backup-objects-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = Buffer.from("authoritative markdown", "utf8");
  const checksum = "5dfec0d541768faed010917534902d227f042685a7cf27a75cfd70330b07f7a0";
  const records = [];
  const client = {
    async send() {
      return {
        Body: Readable.from([body.subarray(0, 5), body.subarray(5)]),
        VersionId: "version-3",
        ContentType: "text/markdown; charset=utf-8",
        Metadata: {
          "checksum-sha256": checksum,
          "object-format": "source-markdown-v1"
        }
      };
    }
  };

  const summary = await backupAuthorityObjects({
    client,
    bucket: "backup-bucket",
    directory,
    objects: [{
      objectId: "object/source",
      storageKey: "scope/source.md",
      checksumSha256: checksum,
      byteCount: body.length,
      objectFormat: "source_markdown"
    }],
    write(record) {
      records.push(record);
    }
  });

  assert.deepEqual(summary, { objectCount: 1, byteCount: body.length });
  assert.equal(records[0].versionId, "version-3");
  assert.equal(records[0].storageKey, "scope/source.md");
  assert.equal(records[0].contentType, "text/markdown; charset=utf-8");
  assert.deepEqual(records[0].metadata, {
    "checksum-sha256": checksum,
    "object-format": "source-markdown-v1"
  });
  const backedUp = await readFile(join(directory, records[0].backupFile));
  assert.deepEqual(backedUp, body);
  assert.equal((await stat(join(directory, records[0].backupFile))).isFile(), true);
});

test("authority object verification failure leaves no partial backup file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "focowiki-backup-mismatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = {
    async send() {
      return {
        Body: Readable.from([Buffer.from("wrong body", "utf8")]),
        ContentType: "text/markdown; charset=utf-8",
        Metadata: {
          "checksum-sha256": "0".repeat(64),
          "object-format": "source-markdown-v1"
        }
      };
    }
  };

  await assert.rejects(() => backupAuthorityObjects({
    client,
    bucket: "backup-bucket",
    directory,
    objects: [{
      objectId: "object-mismatch",
      storageKey: "scope/source.md",
      checksumSha256: "0".repeat(64),
      byteCount: 10,
      objectFormat: "source_markdown"
    }],
    write() {}
  }), /verification failed/u);

  assert.deepEqual(await readdir(directory), []);
});

test("backup manifest treats Redis and Meilisearch as rebuildable by default", () => {
  const manifest = createBackupManifest({
    backupId: "focowiki-20260802T000000Z",
    createdAt: "2026-08-02T00:00:00.000Z",
    postgresDump: "postgres/focowiki.dump",
    runtimeSettingsExport: "postgres/runtime-settings.ndjson",
    s3: {
      bucket: "backup-bucket",
      prefix: "scope/",
      authorityObjectCount: 2,
      authorityByteCount: 20,
      inventory: {
        currentObjectCount: 2,
        currentBytes: 20,
        noncurrentVersionCount: 1,
        noncurrentBytes: 10,
        deleteMarkerCount: 1,
        multipartUploadCount: 0
      }
    },
    files: []
  });

  assert.equal(manifest.format, "focowiki-storage-vnext-backup-v1");
  assert.equal(manifest.postgres.includesRuntimeSettings, true);
  assert.equal(manifest.redis.mode, "rebuild");
  assert.equal(manifest.meilisearch.mode, "rebuild");
  assert.equal(manifest.s3.includesAuthorityObjects, true);
  assert.equal(manifest.s3.includesVersionInventory, true);
});

test("isolated backup workflow creates a checksummed restorable archive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "focowiki-backup-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDirectory = join(root, "bin");
  const runtimeSecretsDirectory = join(root, "runtime-secrets");
  await mkdir(binDirectory);
  await mkdir(runtimeSecretsDirectory);
  await writeFile(join(root, ".env"), "POSTGRES_DB=focowiki\n");
  await writeFile(join(root, "docker-compose.yml"), "services: {}\n");
  await writeFile(join(runtimeSecretsDirectory, "deployment.key"), `${"a".repeat(43)}\n`);

  const dockerCommand = join(binDirectory, "docker");
  const dockerCommandLog = join(root, "docker-command-log.ndjson");
  await writeFile(dockerCommand, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "docker-command-log.ndjson"))}, JSON.stringify(args) + "\\n");
if (args.includes("ps")) {
  process.stdout.write("postgres\\n");
} else if (args.some((value) => value.includes("pg_dump"))) {
  process.stdout.write("fake-postgres-dump");
} else if (args.some((value) => value.includes("pg_restore"))) {
  process.stdin.resume();
} else {
  const sql = args.at(-1) ?? "";
  if (sql.includes("information_schema.tables")) {
    process.stdout.write("0\\n");
  } else if (sql.includes("runtime_generation")) {
    process.stdout.write("storage-vnext-v2\\n");
  } else if (sql.includes("runtime_setting_revisions")) {
    process.stdout.write(JSON.stringify({ publicId: "settings-1", isCurrent: true }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({
      objectId: "object-1",
      storageKey: "scope/source.md",
      checksumSha256: "5dfec0d541768faed010917534902d227f042685a7cf27a75cfd70330b07f7a0",
      byteCount: 22,
      objectFormat: "source_markdown"
    }) + "\\n");
  }
}
`, { mode: 0o700 });
  await chmod(dockerCommand, 0o700);

  const body = Buffer.from("authoritative markdown", "utf8");
  const s3Client = {
    async send(command) {
      switch (command.constructor.name) {
        case "ListObjectVersionsCommand":
          return {
            Versions: [{
              Key: "scope/source.md",
              VersionId: "version-3",
              IsLatest: true,
              Size: body.length
            }],
            IsTruncated: false
          };
        case "ListMultipartUploadsCommand":
          return { Uploads: [], IsTruncated: false };
        default:
          return {
            Body: Readable.from([body]),
            VersionId: "version-3",
            ContentType: "text/markdown; charset=utf-8",
            Metadata: {
              "checksum-sha256": createHash("sha256").update(body).digest("hex"),
              "object-format": "source-markdown-v1"
            }
          };
      }
    }
  };

  const result = await createStorageVnextBackup({
    rootDirectory: root,
    backupId: "focowiki-isolated-test",
    createdAt: "2026-08-02T00:00:00.000Z",
    dockerCommand,
    postgresDatabase: "focowiki_svnext_test",
    s3Client,
    environment: {
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_REGION: "us-east-1",
      S3_BUCKET: "backup-bucket",
      S3_ACCESS_KEY_ID: "test-access-key",
      S3_SECRET_ACCESS_KEY: "test-secret-key",
      S3_PREFIX: "scope",
      S3_FORCE_PATH_STYLE: "true"
    }
  });

  assert.equal(result.authorityObjectCount, 1);
  assert.equal(result.authorityByteCount, body.length);
  assert.equal((await stat(result.archivePath)).isFile(), true);
  assert.match(await readFile(result.checksumPath, "utf8"), new RegExp(result.sha256, "u"));

  const restored = join(root, "restored");
  await mkdir(restored);
  const extraction = spawnSync("tar", ["-xzf", result.archivePath, "-C", restored]);
  assert.equal(extraction.status, 0, extraction.stderr?.toString("utf8"));
  const manifest = JSON.parse(await readFile(join(restored, "manifest.json"), "utf8"));
  assert.equal(manifest.postgres.includesRuntimeSettings, true);
  assert.equal(manifest.s3.authorityObjectCount, 1);
  assert.equal(manifest.meilisearch.mode, "rebuild");
  assert.equal((await stat(join(root, "backups", ".focowiki-isolated-test.staging"))
    .catch(() => null)), null);

  const restoredBodies = new Map();
  const restoredHeaders = new Map();
  const restoreS3Client = {
    async send(command) {
      switch (command.constructor.name) {
        case "ListObjectVersionsCommand":
          throw Object.assign(new Error("ListObjectVersions not implemented"), {
            name: "NotImplemented",
            Code: "NotImplemented",
            $metadata: { httpStatusCode: 501 }
          });
        case "ListObjectsV2Command":
          return {
            Contents: [{ Key: "scope/_run-owner.json" }],
            IsTruncated: false
          };
        case "ListMultipartUploadsCommand":
          return { Uploads: [], IsTruncated: false };
        case "PutObjectCommand": {
          const chunks = [];
          for await (const chunk of command.input.Body) chunks.push(Buffer.from(chunk));
          restoredBodies.set(command.input.Key, Buffer.concat(chunks));
          restoredHeaders.set(command.input.Key, {
            contentType: command.input.ContentType,
            metadata: command.input.Metadata
          });
          return { VersionId: "restored-version" };
        }
        case "GetObjectCommand":
          return { Body: Readable.from([restoredBodies.get(command.input.Key)]) };
        default:
          throw new Error(`Unexpected restore command: ${command.constructor.name}`);
      }
    }
  };
  const restoreRuntimeSecretsDirectory = join(root, "restored-runtime-secrets");
  await mkdir(restoreRuntimeSecretsDirectory);
  const restoreResult = await createStorageVnextRestore({
    rootDirectory: root,
    archivePath: result.archivePath,
    checksumPath: result.checksumPath,
    dockerCommand,
    postgresDatabase: "focowiki_svnext_test",
    runtimeSecretsDirectory: restoreRuntimeSecretsDirectory,
    s3Client: restoreS3Client,
    environment: {
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_REGION: "us-east-1",
      S3_BUCKET: "backup-bucket",
      S3_ACCESS_KEY_ID: "test-access-key",
      S3_SECRET_ACCESS_KEY: "test-secret-key",
      S3_PREFIX: "scope",
      S3_FORCE_PATH_STYLE: "true"
    }
  });

  assert.equal(restoreResult.backupId, "focowiki-isolated-test");
  assert.equal(restoreResult.authorityObjectCount, 1);
  assert.equal(restoreResult.authorityByteCount, body.length);
  assert.deepEqual(restoredBodies.get("scope/source.md"), body);
  assert.deepEqual(restoredHeaders.get("scope/source.md"), {
    contentType: "text/markdown; charset=utf-8",
    metadata: {
      "checksum-sha256": createHash("sha256").update(body).digest("hex"),
      "object-format": "source-markdown-v1"
    }
  });
  const dockerCommands = (await readFile(dockerCommandLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const postgresCommands = dockerCommands.filter((arguments_) =>
    arguments_.some((value) => /pg_dump|psql|pg_restore/u.test(value)));
  assert.equal(postgresCommands.length, 6);
  for (const arguments_ of postgresCommands) {
    assert.equal(arguments_.includes("focowiki_svnext_test"), true);
  }
  const pgDumpCommand = postgresCommands.find((arguments_) =>
    arguments_.some((value) => value.includes("pg_dump")));
  assert.equal(
    pgDumpCommand.some((value) => value.includes("--exclude-schema=focowiki_validation")),
    true
  );
  assert.equal(
    await readFile(join(restoreRuntimeSecretsDirectory, "deployment.key"), "utf8"),
    `${"a".repeat(43)}\n`
  );
  assert.equal(await stat(restoreResult.stagingDirectory).catch(() => null), null);
});

test("deployment exposes the verified storage-vNext backup command", async () => {
  const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  const source = await readFile(
    join(rootDir, "scripts/deployment/storage-vnext-backup.mjs"),
    "utf8"
  );

  assert.equal(
    packageJson.scripts["compose:backup"],
    "node scripts/deployment/storage-vnext-backup.mjs"
  );
  assert.match(source, /pg_dump/u);
  assert.match(source, /runtime-secrets/u);
  assert.match(source, /runtime-settings\.ndjson/u);
  assert.match(source, /s3-version-inventory\.ndjson/u);
  assert.match(source, /meilisearch-snapshot-sha256/u);
});

test("deployment exposes the verified storage-vNext restore command", async () => {
  const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  const source = await readFile(
    join(rootDir, "scripts/deployment/storage-vnext-restore.mjs"),
    "utf8"
  );

  assert.equal(
    packageJson.scripts["compose:restore"],
    "node scripts/deployment/storage-vnext-restore.mjs"
  );
  assert.match(source, /pg_restore/u);
  assert.match(source, /information_schema\.tables/u);
  assert.match(source, /authority-objects\.ndjson/u);
  assert.match(source, /checksum/u);
  assert.match(source, /clean/u);
});

test("restore validation rebuilds the unified index from PostgreSQL and S3", async () => {
  const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  const source = await readFile(
    join(rootDir, "scripts/validation/storage-vnext-restore-rebuild.ts"),
    "utf8"
  );

  assert.equal(
    packageJson.scripts["validate:storage-vnext:restore-rebuild"],
    "tsx scripts/validation/storage-vnext-restore-rebuild.ts"
  );
  assert.match(source, /createStorageVnextMaintenanceSearchRebuild/u);
  assert.match(source, /createPostgresStorageVnextCatalogRepository/u);
  assert.match(source, /createPostgresStorageVnextGraphRepository/u);
  assert.match(source, /createS3StorageVnextSourceBodyStore/u);
  assert.match(source, /createMeilisearchTransport/u);
  assert.match(source, /one unified index/u);
});

test("full restore rebuild counts only current non-deleted source authority", async () => {
  const source = await readFile(
    join(rootDir, "scripts/validation/storage-vnext-full-restore-rebuild.ts"),
    "utf8"
  );

  assert.match(source, /source_file_current_revisions/u);
  assert.match(source, /source\.deleted_at IS NULL/u);
  assert.doesNotMatch(source, /source_files[\s\S]{0,200}visibility/u);
});

test("restore rejects authority objects outside the exact backup prefix before writing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "focowiki-restore-prefix-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const objectDirectory = join(directory, "s3", "objects");
  await mkdir(objectDirectory, { recursive: true });
  const body = Buffer.from("scoped markdown", "utf8");
  const checksumSha256 = createHash("sha256").update(body).digest("hex");
  const backupFile = `${"a".repeat(64)}.blob`;
  await writeFile(join(objectDirectory, backupFile), body);
  const manifestPath = join(directory, "s3", "authority-objects.ndjson");
  await writeFile(manifestPath, `${JSON.stringify({
    objectId: "object-outside-scope",
    storageKey: "another-scope/source.md",
    checksumSha256,
    byteCount: body.length,
    objectFormat: "source_markdown",
    contentType: "text/markdown; charset=utf-8",
    metadata: {
      "checksum-sha256": checksumSha256,
      "object-format": "source-markdown-v1"
    },
    backupFile
  })}\n`);
  let providerCalls = 0;

  await assert.rejects(() => restoreAuthorityObjects({
    client: { async send() { providerCalls += 1; } },
    bucket: "backup-bucket",
    prefix: "scope/",
    directory,
    manifestPath
  }), /restore manifest is invalid/u);
  assert.equal(providerCalls, 0);
});
