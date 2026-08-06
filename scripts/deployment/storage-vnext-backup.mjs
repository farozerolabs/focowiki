import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { loadEnvFile } from "node:process";
import { spawn } from "node:child_process";
import {
  assertNoActiveWriters,
  createAuthorityObjectSql,
  createBackupManifest,
  createComposeArguments,
  createRuntimeSettingsSql,
  resolveStorageVnextPostgresDatabase
} from "./storage-vnext-backup-contract.mjs";
import {
  backupAuthorityObjects,
  writeS3VersionInventory
} from "./storage-vnext-s3-backup.mjs";

const require = createRequire(resolve(import.meta.dirname, "../../apps/api/package.json"));
const { S3Client } = require("@aws-sdk/client-s3");
const MAX_COMMAND_ERROR_BYTES = 64 * 1024;

export async function createStorageVnextBackup(options = {}) {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const composeFile = resolve(rootDirectory, options.composeFile ?? "docker-compose.yml");
  const envFile = resolve(rootDirectory, options.envFile ?? ".env");
  const runtimeSecretsDirectory = resolve(
    rootDirectory,
    options.runtimeSecretsDirectory ?? "runtime-secrets"
  );
  const outputDirectory = resolve(rootDirectory, options.outputDirectory ?? "backups");
  const dockerCommand = options.dockerCommand ?? "docker";
  const tarCommand = options.tarCommand ?? "tar";
  const createdAt = options.createdAt ?? new Date().toISOString();
  const backupId = options.backupId ?? createBackupId(createdAt);
  assertBackupId(backupId);

  await assertRegularFile(composeFile, "Compose file");
  await assertRegularFile(envFile, "Environment file");
  await assertDirectory(runtimeSecretsDirectory, "Runtime secrets directory");
  await ensurePrivateOutputDirectory(outputDirectory);

  const stagingDirectory = join(outputDirectory, `.${backupId}.staging`);
  const archivePath = join(outputDirectory, `${backupId}.tar.gz`);
  const temporaryArchivePath = `${archivePath}.partial`;
  const checksumPath = `${archivePath}.sha256`;
  await assertMissing(stagingDirectory, "Backup staging directory");
  await assertMissing(archivePath, "Backup archive");
  await assertMissing(checksumPath, "Backup checksum");
  await mkdir(stagingDirectory, { mode: 0o700 });
  let completed = false;

  try {
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
      throw new Error("Backup requires the PostgreSQL service to be running");
    }

    const postgresDirectory = join(stagingDirectory, "postgres");
    const s3Directory = join(stagingDirectory, "s3");
    const configurationDirectory = join(stagingDirectory, "configuration");
    await mkdir(postgresDirectory, { recursive: true, mode: 0o700 });
    await mkdir(s3Directory, { recursive: true, mode: 0o700 });
    await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });

    const postgresDump = join(postgresDirectory, "focowiki.dump");
    await runCommandToFile(
      dockerCommand,
      [
        ...composeArguments,
        "exec",
        "-T",
        "postgres",
        "sh",
        "-ceu",
        'exec pg_dump --username="$POSTGRES_USER" --dbname="$1" --format=custom --no-owner --no-privileges --exclude-schema=focowiki_validation',
        "backup-dump",
        postgresDatabase
      ],
      postgresDump,
      "create PostgreSQL backup"
    );

    const runtimeSettingsExport = join(postgresDirectory, "runtime-settings.ndjson");
    await runPostgresQueryToFile(
      dockerCommand,
      composeArguments,
      postgresDatabase,
      createRuntimeSettingsSql(),
      runtimeSettingsExport,
      "export runtime settings"
    );
    const authorityQueryExport = join(postgresDirectory, "authority-objects.ndjson");
    await runPostgresQueryToFile(
      dockerCommand,
      composeArguments,
      postgresDatabase,
      createAuthorityObjectSql(),
      authorityQueryExport,
      "export authoritative object ownership"
    );

    const s3Config = loadS3Config(options.environment ?? process.env);
    const s3Client = options.s3Client ?? new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey
      },
      forcePathStyle: s3Config.forcePathStyle
    });
    let versionInventory;
    let authoritySummary;
    try {
      const versionInventoryPath = join(s3Directory, "s3-version-inventory.ndjson");
      const versionInventoryWriter = await createNdjsonWriter(versionInventoryPath);
      try {
        versionInventory = await writeS3VersionInventory({
          client: s3Client,
          bucket: s3Config.bucket,
          prefix: s3Config.prefix,
          write: versionInventoryWriter.write
        });
      } finally {
        await versionInventoryWriter.close();
      }

      const authorityManifestPath = join(s3Directory, "authority-objects.ndjson");
      const authorityManifestWriter = await createNdjsonWriter(authorityManifestPath);
      try {
        authoritySummary = await backupAuthorityObjects({
          client: s3Client,
          bucket: s3Config.bucket,
          directory: join(s3Directory, "objects"),
          objects: readNdjson(authorityQueryExport),
          write: authorityManifestWriter.write
        });
      } finally {
        await authorityManifestWriter.close();
      }
    } finally {
      if (!options.s3Client) s3Client.destroy?.();
    }

    await copyFile(envFile, join(configurationDirectory, ".env"));
    await copyFile(composeFile, join(configurationDirectory, "docker-compose.yml"));
    await cp(runtimeSecretsDirectory, join(stagingDirectory, "runtime-secrets"), {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    await secureTree(configurationDirectory);
    await secureTree(join(stagingDirectory, "runtime-secrets"));

    const meilisearchSnapshot = await includeMeilisearchSnapshot({
      stagingDirectory,
      path: options.meilisearchSnapshot,
      expectedSha256: options.meilisearchSnapshotSha256
    });
    const files = await buildFileInventory(stagingDirectory);
    const manifest = createBackupManifest({
      backupId,
      createdAt,
      postgresDump: "postgres/focowiki.dump",
      runtimeSettingsExport: "postgres/runtime-settings.ndjson",
      s3: {
        bucket: s3Config.bucket,
        prefix: s3Config.prefix,
        authorityObjectCount: authoritySummary.objectCount,
        authorityByteCount: authoritySummary.byteCount,
        inventory: versionInventory
      },
      meilisearchSnapshot,
      files
    });
    await writeFile(
      join(stagingDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );

    await runCommand(
      tarCommand,
      ["-czf", temporaryArchivePath, "-C", stagingDirectory, "."],
      "create backup archive"
    );
    await runCommand(
      tarCommand,
      ["-tzf", temporaryArchivePath],
      "verify backup archive"
    );
    await chmod(temporaryArchivePath, 0o600);
    await rename(temporaryArchivePath, archivePath);
    const archiveSha256 = await sha256File(archivePath);
    await writeFile(
      checksumPath,
      `${archiveSha256}  ${basename(archivePath)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );
    completed = true;

    return {
      backupId,
      archivePath,
      checksumPath,
      sha256: archiveSha256,
      authorityObjectCount: authoritySummary.objectCount,
      authorityByteCount: authoritySummary.byteCount
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    await rm(temporaryArchivePath, { force: true });
    if (!completed) {
      await rm(archivePath, { force: true });
      await rm(checksumPath, { force: true });
    }
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Backup option requires a value: ${argument ?? "<missing>"}`);
    }
    index += 1;
    switch (argument) {
      case "--compose-file": options.composeFile = value; break;
      case "--project-name": options.composeProjectName = value; break;
      case "--postgres-database": options.postgresDatabase = value; break;
      case "--env-file": options.envFile = value; break;
      case "--runtime-secrets-dir": options.runtimeSecretsDirectory = value; break;
      case "--output-dir": options.outputDirectory = value; break;
      case "--backup-id": options.backupId = value; break;
      case "--meilisearch-snapshot": options.meilisearchSnapshot = value; break;
      case "--meilisearch-snapshot-sha256":
        options.meilisearchSnapshotSha256 = value;
        break;
      default: throw new Error(`Unknown backup option: ${argument}`);
    }
  }
  return options;
}

async function runPostgresQueryToFile(
  dockerCommand,
  composeArguments,
  postgresDatabase,
  sql,
  output,
  label
) {
  await runCommandToFile(
    dockerCommand,
    [
      ...composeArguments,
      "exec",
      "-T",
      "postgres",
      "sh",
      "-ceu",
      'exec psql --username="$POSTGRES_USER" --dbname="$1" --no-align --tuples-only --set ON_ERROR_STOP=1 --command="$2"',
      "backup-query",
      postgresDatabase,
      sql
    ],
    output,
    label
  );
}

function loadS3Config(env) {
  const prefix = requiredEnv(env, "S3_PREFIX").replace(/^\/+|\/+$/gu, "");
  if (!prefix) throw new Error("S3_PREFIX must identify a non-empty backup scope");
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
  if (!value) throw new Error(`${name} is required for backup`);
  return value;
}

async function includeMeilisearchSnapshot(input) {
  if (!input.path && !input.expectedSha256) return undefined;
  if (!input.path || !input.expectedSha256) {
    throw new Error(
      "Both --meilisearch-snapshot and --meilisearch-snapshot-sha256 are required"
    );
  }
  const expected = input.expectedSha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(expected)) {
    throw new Error("Meilisearch snapshot SHA-256 is invalid");
  }
  const source = resolve(input.path);
  await assertRegularFile(source, "Meilisearch snapshot");
  const actual = await sha256File(source);
  if (actual !== expected) {
    throw new Error("Meilisearch snapshot SHA-256 does not match");
  }
  const directory = join(input.stagingDirectory, "optional", "meilisearch");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, "snapshot");
  await copyFile(source, target);
  await chmod(target, 0o600);
  return { file: "optional/meilisearch/snapshot", sha256: actual };
}

async function createNdjsonWriter(path) {
  const handle = await open(path, "wx", 0o600);
  return {
    async write(record) {
      await handle.write(`${JSON.stringify(record)}\n`);
    },
    close: () => handle.close()
  };
}

async function* readNdjson(path) {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const value = JSON.parse(line);
    if (
      typeof value.objectId !== "string"
      || typeof value.storageKey !== "string"
      || typeof value.checksumSha256 !== "string"
      || !Number.isSafeInteger(Number(value.byteCount))
    ) {
      throw new Error("PostgreSQL authority object export is invalid");
    }
    yield { ...value, byteCount: Number(value.byteCount) };
  }
}

async function buildFileInventory(directory) {
  const files = [];
  await walk(directory, "", files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(directory, prefix, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Backup input contains a symlink: ${path}`);
    if (entry.isDirectory()) {
      await walk(absolute, path, files);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Backup input is not a regular file: ${path}`);
    const details = await stat(absolute);
    files.push({ path, bytes: details.size, sha256: await sha256File(absolute) });
  }
}

async function secureTree(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Backup source contains a symlink: ${path}`);
    if (entry.isDirectory()) {
      await secureTree(path);
    } else if (entry.isFile()) {
      await chmod(path, 0o600);
    } else {
      throw new Error(`Backup source is not a regular file: ${path}`);
    }
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function createBackupId(createdAt) {
  return `focowiki-${createdAt.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")}`;
}

function assertBackupId(value) {
  if (!/^focowiki-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error("Backup ID is invalid");
  }
}

async function ensurePrivateOutputDirectory(path) {
  try {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error("Backup output path must be a real directory");
    }
    await chmod(path, 0o700);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
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

async function assertRegularFile(path, label) {
  const details = await lstat(path).catch((error) => {
    if (isNodeError(error, "ENOENT")) throw new Error(`${label} is unavailable`);
    throw error;
  });
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
}

async function assertMissing(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(`${label} already exists`);
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

async function runCommandToFile(command, arguments_, output, label) {
  const handle = await open(output, "wx", 0o600);
  try {
    const child = spawn(command, arguments_, {
      stdio: ["ignore", handle.fd, "pipe"]
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => pushBounded(stderr, chunk));
    const code = await waitForChild(child);
    if (code !== 0) throw commandError(label, stderr);
  } finally {
    await handle.close();
  }
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await createStorageVnextBackup(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ status: "complete", ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Backup failed"}\n`);
    process.exitCode = 1;
  }
}
