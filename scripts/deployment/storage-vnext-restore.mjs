import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { loadEnvFile } from "node:process";
import { spawn } from "node:child_process";
import {
  assertNoActiveWriters,
  createComposeArguments,
  resolveStorageVnextPostgresDatabase
} from "./storage-vnext-backup-contract.mjs";

const require = createRequire(resolve(import.meta.dirname, "../../apps/api/package.json"));
const {
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client
} = require("@aws-sdk/client-s3");
const MAX_COMMAND_ERROR_BYTES = 64 * 1024;
const CURRENT_STORAGE_VNEXT_GENERATION = "storage-vnext-v3-semantic";

export async function createStorageVnextRestore(options = {}) {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const composeFile = resolve(rootDirectory, options.composeFile ?? "docker-compose.yml");
  const envFile = resolve(rootDirectory, options.envFile ?? ".env");
  const archivePath = resolveRequiredPath(
    rootDirectory,
    options.archivePath,
    "Backup archive"
  );
  const checksumPath = resolveRequiredPath(
    rootDirectory,
    options.checksumPath,
    "Backup checksum"
  );
  const dockerCommand = options.dockerCommand ?? "docker";
  const tarCommand = options.tarCommand ?? "tar";
  const runtimeSecretsDirectory = resolve(
    rootDirectory,
    options.runtimeSecretsDirectory ?? "runtime-secrets"
  );

  await assertRegularFile(composeFile, "Compose file");
  await assertRegularFile(envFile, "Environment file");
  await assertRegularFile(archivePath, "Backup archive");
  await assertRegularFile(checksumPath, "Backup checksum");
  await verifyArchiveChecksum(archivePath, checksumPath);

  const restoreParent = resolve(options.restoreParentDirectory ?? dirname(archivePath));
  await ensureRealDirectory(restoreParent, "Restore parent directory");
  const stagingDirectory = await mkdtemp(join(restoreParent, ".storage-vnext-restore-"));

  try {
    await validateArchiveEntries(tarCommand, archivePath);
    await runCommand(
      tarCommand,
      ["-xzf", archivePath, "-C", stagingDirectory],
      "extract backup archive"
    );
    const manifest = await verifyExtractedBackup(stagingDirectory);

    loadEnvFile(envFile);
    const postgresDatabase = resolveStorageVnextPostgresDatabase(
      options.postgresDatabase ?? process.env.POSTGRES_DB
    );
    const composeArguments = createComposeArguments({
      projectName: options.composeProjectName,
      envFile,
      composeFile
    });
    const runningServices = (await captureCommand(
      dockerCommand,
      [...composeArguments, "ps", "--status", "running", "--services"],
      "read running Compose services"
    )).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    assertNoActiveWriters(runningServices);
    if (!runningServices.includes("postgres")) {
      throw new Error("Restore requires the PostgreSQL service to be running");
    }

    await assertCleanPostgresTarget(dockerCommand, composeArguments, postgresDatabase);
    await ensureEmptyRealDirectory(
      runtimeSecretsDirectory,
      "Runtime secrets restore target"
    );
    const s3Config = loadS3Config(options.environment ?? process.env);
    if (manifest.s3.prefix !== s3Config.prefix) {
      throw new Error("Restore target S3 prefix must match the backup authority");
    }
    const s3Client = options.s3Client ?? new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey
      },
      forcePathStyle: s3Config.forcePathStyle
    });

    try {
      await assertCleanS3Target(s3Client, s3Config.bucket, s3Config.prefix);
      await runCommandFromFile(
        dockerCommand,
        [
          ...composeArguments,
          "exec",
          "-T",
          "postgres",
          "sh",
          "-ceu",
          'exec pg_restore --username="$POSTGRES_USER" --dbname="$1" --no-owner --no-privileges --exit-on-error',
          "restore-dump",
          postgresDatabase
        ],
        join(stagingDirectory, manifest.postgres.dump),
        "restore PostgreSQL backup"
      );
      await assertRestoredPostgresTarget(
        dockerCommand,
        composeArguments,
        postgresDatabase
      );
      const authority = await restoreAuthorityObjects({
        client: s3Client,
        bucket: s3Config.bucket,
        prefix: s3Config.prefix,
        directory: stagingDirectory,
        manifestPath: join(stagingDirectory, manifest.s3.authorityManifest)
      });
      if (
        authority.objectCount !== manifest.s3.authorityObjectCount
        || authority.byteCount !== manifest.s3.authorityByteCount
      ) {
        throw new Error("Restored authority object totals do not match the backup manifest");
      }
      await restoreRuntimeSecrets(
        join(stagingDirectory, manifest.runtimeSecrets.directory),
        runtimeSecretsDirectory
      );

      return {
        backupId: manifest.backupId,
        stagingDirectory,
        authorityObjectCount: authority.objectCount,
        authorityByteCount: authority.byteCount,
        meilisearchMode: manifest.meilisearch.mode
      };
    } finally {
      if (!options.s3Client) s3Client.destroy?.();
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function restoreAuthorityObjects(input) {
  let objectCount = 0;
  let byteCount = 0;
  for await (const object of readNdjson(input.manifestPath)) {
    validateAuthorityObject(object, input.prefix);
    const source = resolve(input.directory, "s3", "objects", object.backupFile);
    assertInside(input.directory, source, "Authority object backup path");
    await assertRegularFile(source, "Authority object backup");
    const sourceDetails = await stat(source);
    if (
      sourceDetails.size !== object.byteCount
      || await sha256File(source) !== object.checksumSha256
    ) {
      throw new Error(`Authority object backup verification failed for ${object.objectId}`);
    }

    await input.client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: object.storageKey,
      Body: createReadStream(source),
      ContentType: object.contentType,
      Metadata: object.metadata
    }));
    const restored = await input.client.send(new GetObjectCommand({
      Bucket: input.bucket,
      Key: object.storageKey
    }));
    const verification = await hashObjectBody(restored.Body, object.objectId);
    if (
      verification.byteCount !== object.byteCount
      || verification.checksumSha256 !== object.checksumSha256
    ) {
      throw new Error(`Restored authority object verification failed for ${object.objectId}`);
    }
    objectCount += 1;
    byteCount += object.byteCount;
  }
  return { objectCount, byteCount };
}

async function verifyExtractedBackup(directory) {
  const manifestPath = join(directory, "manifest.json");
  await assertRegularFile(manifestPath, "Backup manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);

  const expectedFiles = new Set(["manifest.json"]);
  for (const entry of manifest.files) {
    validateRelativePath(entry.path, "Backup file inventory path");
    if (expectedFiles.has(entry.path)) {
      throw new Error(`Backup file inventory contains a duplicate path: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !isSha256(entry.sha256)) {
      throw new Error(`Backup file inventory is invalid for ${entry.path}`);
    }
    const path = resolve(directory, entry.path);
    assertInside(directory, path, "Backup file inventory path");
    await assertRegularFile(path, "Backup inventory file");
    const details = await stat(path);
    if (details.size !== entry.bytes || await sha256File(path) !== entry.sha256) {
      throw new Error(`Backup file inventory verification failed for ${entry.path}`);
    }
    expectedFiles.add(entry.path);
  }

  for (const requiredPath of [
    manifest.postgres.dump,
    manifest.postgres.runtimeSettingsExport,
    manifest.s3.authorityManifest,
    manifest.s3.versionInventory,
    manifest.configuration.env,
    manifest.configuration.compose
  ]) {
    if (!expectedFiles.has(requiredPath)) {
      throw new Error(`Backup manifest file is missing from inventory: ${requiredPath}`);
    }
  }
  await assertDirectory(
    join(directory, manifest.runtimeSecrets.directory),
    "Backup runtime secrets directory"
  );

  const actualFiles = new Set(await listRegularFiles(directory));
  if (
    actualFiles.size !== expectedFiles.size
    || [...actualFiles].some((path) => !expectedFiles.has(path))
  ) {
    throw new Error("Backup archive contains an unlisted file or missing inventory entry");
  }
  return manifest;
}

function validateManifest(manifest) {
  if (
    !isRecord(manifest)
    || manifest.format !== "focowiki-storage-vnext-backup-v1"
    || !/^focowiki-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(manifest.backupId)
    || !isRecord(manifest.postgres)
    || manifest.postgres.format !== "custom"
    || !isRecord(manifest.s3)
    || manifest.s3.includesAuthorityObjects !== true
    || manifest.s3.includesVersionInventory !== true
    || manifest.s3.authorityManifest !== "s3/authority-objects.ndjson"
    || manifest.s3.versionInventory !== "s3/s3-version-inventory.ndjson"
    || !Number.isSafeInteger(manifest.s3.authorityObjectCount)
    || manifest.s3.authorityObjectCount < 0
    || !Number.isSafeInteger(manifest.s3.authorityByteCount)
    || manifest.s3.authorityByteCount < 0
    || !isRecord(manifest.configuration)
    || !isRecord(manifest.runtimeSecrets)
    || manifest.runtimeSecrets.directory !== "runtime-secrets"
    || manifest.runtimeSecrets.included !== true
    || !isRecord(manifest.meilisearch)
    || !["rebuild", "snapshot"].includes(manifest.meilisearch.mode)
    || !Array.isArray(manifest.files)
  ) {
    throw new Error("Storage vNext backup manifest is invalid");
  }
  for (const path of [
    manifest.postgres.dump,
    manifest.postgres.runtimeSettingsExport,
    manifest.s3.authorityManifest,
    manifest.s3.versionInventory,
    manifest.configuration?.env,
    manifest.configuration?.compose
  ]) {
    validateRelativePath(path, "Backup manifest path");
  }
  if (
    typeof manifest.s3.bucket !== "string"
    || !manifest.s3.bucket
    || typeof manifest.s3.prefix !== "string"
    || !manifest.s3.prefix.endsWith("/")
    || manifest.s3.prefix.startsWith("/")
    || manifest.s3.prefix.includes("..")
    || manifest.s3.prefix.includes("\\")
  ) {
    throw new Error("Storage vNext backup S3 authority is invalid");
  }
}

async function assertCleanPostgresTarget(
  dockerCommand,
  composeArguments,
  postgresDatabase
) {
  const result = await capturePostgresQuery(
    dockerCommand,
    composeArguments,
    postgresDatabase,
    `SELECT count(*)
     FROM information_schema.tables
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       AND NOT (
         table_schema = 'focowiki_validation'
         AND table_name = 'run_owner'
       );`,
    "inspect clean PostgreSQL restore target"
  );
  if (result !== "0") {
    throw new Error("PostgreSQL restore target is not clean");
  }
}

async function assertRestoredPostgresTarget(
  dockerCommand,
  composeArguments,
  postgresDatabase
) {
  const result = await capturePostgresQuery(
    dockerCommand,
    composeArguments,
    postgresDatabase,
    "SELECT generation FROM focowiki.runtime_generation WHERE singleton = true;",
    "verify restored PostgreSQL schema"
  );
  if (result !== CURRENT_STORAGE_VNEXT_GENERATION) {
    throw new Error("Restored PostgreSQL schema generation is invalid");
  }
}

async function capturePostgresQuery(
  dockerCommand,
  composeArguments,
  postgresDatabase,
  sql,
  label
) {
  return (await captureCommand(
    dockerCommand,
    [
      ...composeArguments,
      "exec",
      "-T",
      "postgres",
      "sh",
      "-ceu",
      'exec psql --username="$POSTGRES_USER" --dbname="$1" --no-align --tuples-only --set ON_ERROR_STOP=1 --command="$2"',
      "restore-query",
      postgresDatabase,
      sql
    ],
    label
  )).trim();
}

async function assertCleanS3Target(client, bucket, prefix) {
  const ownerMarkerKey = `${prefix}_run-owner.json`;
  try {
    const versions = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 2
    }));
    const objectVersions = versions.Versions ?? [];
    const markerOnly = objectVersions.length === 0 || (
      objectVersions.length === 1
      && objectVersions[0]?.Key === ownerMarkerKey
      && objectVersions[0]?.IsLatest === true
    );
    if (
      !markerOnly
      || (versions.DeleteMarkers?.length ?? 0) > 0
      || versions.IsTruncated === true
    ) throw new Error("S3 restore target is not clean");
  } catch (error) {
    if (!isVersionListingUnsupported(error)) throw error;
    const objects = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 2
    }));
    const current = objects.Contents ?? [];
    const markerOnly = current.length === 0 || (
      current.length === 1 && current[0]?.Key === ownerMarkerKey
    );
    if (!markerOnly || objects.IsTruncated === true) {
      throw new Error("S3 restore target is not clean");
    }
  }
  const multipart = await client.send(new ListMultipartUploadsCommand({
    Bucket: bucket,
    Prefix: prefix,
    MaxUploads: 1
  }));
  if ((multipart.Uploads?.length ?? 0) > 0 || multipart.IsTruncated === true) {
    throw new Error("S3 restore target has unfinished multipart uploads");
  }
}

function isVersionListingUnsupported(error) {
  return error && typeof error === "object" && (
    ["NotImplemented", "MethodNotAllowed", "UnsupportedOperation"].includes(error.name)
    || ["NotImplemented", "MethodNotAllowed", "UnsupportedOperation"].includes(error.Code)
    || error.$metadata?.httpStatusCode === 501
    || error.$metadata?.httpStatusCode === 405
  );
}

async function restoreRuntimeSecrets(source, target) {
  await assertDirectory(source, "Backup runtime secrets directory");
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const details = await lstat(sourcePath);
    if (details.isSymbolicLink()) {
      throw new Error("Backup runtime secrets contain a symbolic link");
    }
    await cp(sourcePath, join(target, entry.name), {
      recursive: true,
      errorOnExist: true,
      force: false
    });
  }
  await secureTree(target);
}

async function ensureEmptyRealDirectory(path, label) {
  await ensureRealDirectory(path, label);
  if ((await readdir(path)).length > 0) {
    throw new Error(`${label} is not clean`);
  }
}

async function secureTree(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      throw new Error("Restored runtime secrets contain a symbolic link");
    }
    if (details.isDirectory()) {
      await secureTree(path);
    } else if (details.isFile()) {
      await chmod(path, 0o600);
    } else {
      throw new Error("Restored runtime secrets contain a non-regular entry");
    }
  }
}

function validateAuthorityObject(object, prefix) {
  if (
    !isRecord(object)
    || typeof object.objectId !== "string"
    || typeof object.storageKey !== "string"
    || !object.storageKey.startsWith(prefix)
    || !isSha256(object.checksumSha256)
    || !Number.isSafeInteger(object.byteCount)
    || object.byteCount < 0
    || typeof object.contentType !== "string"
    || !object.contentType
    || typeof object.objectFormat !== "string"
    || !isBoundedStringRecord(object.metadata)
    || !/^[0-9a-f]{64}\.blob$/u.test(object.backupFile)
  ) {
    throw new Error("Authority object restore manifest is invalid");
  }
}

function isBoundedStringRecord(value) {
  return isRecord(value)
    && Object.keys(value).length <= 32
    && Buffer.byteLength(JSON.stringify(value), "utf8") <= 8_192
    && Object.entries(value).every(([key, item]) =>
      key.length > 0 && typeof item === "string");
}

async function hashObjectBody(body, objectId) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    throw new Error(`Restored authority object body is unavailable for ${objectId}`);
  }
  const hash = createHash("sha256");
  let byteCount = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    byteCount += buffer.length;
  }
  return { byteCount, checksumSha256: hash.digest("hex") };
}

async function validateArchiveEntries(tarCommand, archivePath) {
  const entries = (await captureCommand(
    tarCommand,
    ["-tzf", archivePath],
    "list backup archive"
  )).split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) throw new Error("Backup archive is empty");
  for (const entry of entries) {
    const withoutDot = entry.replace(/^\.\//u, "").replace(/\/$/u, "");
    if (!withoutDot) continue;
    validateRelativePath(withoutDot, "Backup archive entry");
  }
}

async function verifyArchiveChecksum(archivePath, checksumPath) {
  const checksum = (await readFile(checksumPath, "utf8")).trim();
  const match = /^([0-9a-f]{64})\s+\*?([^\s]+)$/u.exec(checksum);
  if (!match || match[2] !== basename(archivePath)) {
    throw new Error("Backup checksum file is invalid");
  }
  if (await sha256File(archivePath) !== match[1]) {
    throw new Error("Backup archive checksum does not match");
  }
}

function loadS3Config(env) {
  const prefix = requiredEnv(env, "S3_PREFIX").replace(/^\/+|\/+$/gu, "");
  if (!prefix) throw new Error("S3_PREFIX must identify a non-empty restore scope");
  const forcePathStyle = requiredEnv(env, "S3_FORCE_PATH_STYLE");
  if (forcePathStyle !== "true" && forcePathStyle !== "false") {
    throw new Error("S3_FORCE_PATH_STYLE must be true or false");
  }
  return {
    endpoint: requiredEnv(env, "S3_ENDPOINT"),
    region: requiredEnv(env, "S3_REGION"),
    bucket: requiredEnv(env, "S3_BUCKET"),
    accessKeyId: requiredEnv(env, "S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv(env, "S3_SECRET_ACCESS_KEY"),
    prefix: `${prefix}/`,
    forcePathStyle: forcePathStyle === "true"
  };
}

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for restore`);
  return value;
}

async function* readNdjson(path) {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    yield JSON.parse(line);
  }
}

async function listRegularFiles(directory) {
  const files = [];
  async function walk(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const details = await lstat(path);
      if (details.isSymbolicLink()) {
        throw new Error(`Backup archive contains a symbolic link: ${relativePath}`);
      }
      if (details.isDirectory()) {
        await walk(path, relativePath);
      } else if (details.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`Backup archive contains a non-regular entry: ${relativePath}`);
      }
    }
  }
  await walk(directory, "");
  return files.sort();
}

function validateRelativePath(value, label) {
  if (
    typeof value !== "string"
    || !value
    || isAbsolute(value)
    || value.includes("\\")
    || normalize(value) !== value
    || value === ".."
    || value.startsWith("../")
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function assertInside(directory, path, label) {
  const pathFromRoot = relative(resolve(directory), resolve(path));
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`${label} escapes the restore directory`);
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveRequiredPath(rootDirectory, value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} path is required`);
  return resolve(rootDirectory, value);
}

async function ensureRealDirectory(path, label) {
  try {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`${label} must be a real directory`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}

async function assertRegularFile(path, label) {
  const details = await lstat(path).catch((error) => {
    if (isNodeError(error, "ENOENT")) throw new Error(`${label} is unavailable`);
    throw error;
  });
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
}

async function assertDirectory(path, label) {
  const details = await lstat(path).catch((error) => {
    if (isNodeError(error, "ENOENT")) throw new Error(`${label} is unavailable`);
    throw error;
  });
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

async function captureCommand(command, arguments_, label) {
  const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => pushBounded(stderr, chunk));
  const code = await waitForChild(child);
  if (code !== 0) throw commandError(label, stderr);
  return Buffer.concat(stdout).toString("utf8");
}

async function runCommand(command, arguments_, label) {
  const child = spawn(command, arguments_, { stdio: ["ignore", "ignore", "pipe"] });
  const stderr = [];
  child.stderr.on("data", (chunk) => pushBounded(stderr, chunk));
  const code = await waitForChild(child);
  if (code !== 0) throw commandError(label, stderr);
}

async function runCommandFromFile(command, arguments_, input, label) {
  const child = spawn(command, arguments_, { stdio: ["pipe", "ignore", "pipe"] });
  const stderr = [];
  child.stderr.on("data", (chunk) => pushBounded(stderr, chunk));
  createReadStream(input).pipe(child.stdin);
  const code = await waitForChild(child);
  if (code !== 0) throw commandError(label, stderr);
}

function waitForChild(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
}

function pushBounded(chunks, chunk) {
  const current = chunks.reduce((total, value) => total + value.length, 0);
  if (current >= MAX_COMMAND_ERROR_BYTES) return;
  chunks.push(Buffer.from(chunk).subarray(0, MAX_COMMAND_ERROR_BYTES - current));
}

function commandError(label, stderr) {
  const detail = Buffer.concat(stderr).toString("utf8").trim();
  return new Error(detail ? `${label} failed: ${detail}` : `${label} failed`);
}

function isNodeError(error, code) {
  return typeof error === "object" && error !== null && error.code === code;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Restore option requires a value: ${argument ?? "<missing>"}`);
    }
    index += 1;
    switch (argument) {
      case "--archive": options.archivePath = value; break;
      case "--checksum": options.checksumPath = value; break;
      case "--compose-file": options.composeFile = value; break;
      case "--project-name": options.composeProjectName = value; break;
      case "--postgres-database": options.postgresDatabase = value; break;
      case "--env-file": options.envFile = value; break;
      case "--runtime-secrets-dir": options.runtimeSecretsDirectory = value; break;
      case "--restore-parent": options.restoreParentDirectory = value; break;
      default: throw new Error(`Unknown restore option: ${argument}`);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await createStorageVnextRestore(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ status: "complete", ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Restore failed"}\n`);
    process.exitCode = 1;
  }
}
