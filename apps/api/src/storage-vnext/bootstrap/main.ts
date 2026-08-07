import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { Meilisearch } from "meilisearch";
import postgres from "postgres";
import { createClient } from "redis";
import {
  bootstrapStorageVnextOwnedScope,
  resetStorageVnextOwnedScope
} from "./command.js";
import { createStorageVnextCoordinationPlane } from "./coordination-plane.js";
import { createStorageVnextFilesystemPlane } from "./filesystem-plane.js";
import { createStorageVnextObjectPlane } from "./object-plane.js";
import { validateStorageVnextOwnedScopeProof } from "./owned-scope.js";
import { createStorageVnextPostgresPlane } from "./postgres-plane.js";
import {
  createStorageVnextSearchPlane,
  type StorageVnextOwnedSearchClient,
  type StorageVnextSearchScopeReceipt
} from "./search-plane.js";
import {
  synchronizeStorageVnextSearchReceipt,
  type StorageVnextSearchReceiptClient
} from "./search-receipt.js";
import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";

type CommandManifest = {
  version: 1;
  proof: StorageVnextOwnedScopeProof;
  search: StorageVnextSearchScopeReceipt;
};

const action = process.argv[2];
if (action !== "reset" && action !== "bootstrap") {
  throw new Error("Storage vNext owned-scope command must be reset or bootstrap");
}

const proofFile = requireEnvironment("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE");
if (!isAbsolute(proofFile)) {
  throw new Error("Storage vNext proof file must use an absolute path");
}
const manifest = JSON.parse(readFileSync(proofFile, "utf8")) as CommandManifest;
if (manifest.version !== 1) throw new Error("Unsupported storage vNext proof version");
const proof = validateStorageVnextOwnedScopeProof(manifest.proof);
if (
  resolve(dirname(proofFile)) !== proof.filesystemScope
  || resolve(proofFile) !== join(proof.filesystemScope, "storage-vnext-proof.json")
) {
  throw new Error("Storage vNext proof file must be the exact run-root proof file");
}
if (
  requireEnvironment("FOCOWIKI_STORAGE_VNEXT_DESTRUCTIVE_AUTHORIZATION")
  !== proof.proofChecksum
) {
  throw new Error("Storage vNext destructive authorization does not match the run proof");
}

const databaseUrl = requireEnvironment("DATABASE_URL");
assertDatabaseTarget(databaseUrl, proof.postgresScope);
const objectPrefix = normalizeObjectPrefix(requireEnvironment("S3_PREFIX"));
if (`${objectPrefix}/` !== proof.objectScope) {
  throw new Error("S3_PREFIX does not match the exact run-owned object scope");
}
if (requireEnvironment("SEARCH_PROVIDER") !== "meilisearch") {
  throw new Error("Storage vNext owned-scope validation requires SEARCH_PROVIDER=meilisearch");
}
if (requireEnvironment("SEARCH_INDEX_PREFIX") !== proof.searchScope) {
  throw new Error("SEARCH_INDEX_PREFIX does not match the exact run-owned search scope");
}

const postgresClient = postgres(databaseUrl, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 5
});
const objectClient = new S3Client({
  endpoint: requireEnvironment("S3_ENDPOINT"),
  region: requireEnvironment("S3_REGION"),
  credentials: {
    accessKeyId: requireEnvironment("S3_ACCESS_KEY_ID"),
    secretAccessKey: requireEnvironment("S3_SECRET_ACCESS_KEY")
  },
  forcePathStyle: parseBooleanEnvironment("S3_FORCE_PATH_STYLE")
});
const searchClient = new Meilisearch({
  host: requireEnvironment("MEILI_HOST"),
  apiKey: requireEnvironment("MEILI_API_KEY"),
  timeout: 10_000,
  clientAgents: ["Focowiki storage-vNext owned reset"]
});
const coordinationClient = createClient({
  url: requireEnvironment("REDIS_URL"),
  socket: { reconnectStrategy: false }
});

try {
  await coordinationClient.connect();
  const searchReceipt = action === "reset"
    ? await synchronizeStorageVnextSearchReceipt({
        proof,
        receipt: manifest.search,
        client: searchClient as unknown as StorageVnextSearchReceiptClient
      })
    : manifest.search;
  const planes = [
    createStorageVnextSearchPlane({
      client: searchClient as unknown as StorageVnextOwnedSearchClient,
      receipt: searchReceipt
    }),
    createStorageVnextObjectPlane({
      client: objectClient,
      bucket: requireEnvironment("S3_BUCKET")
    }),
    createStorageVnextCoordinationPlane(coordinationClient),
    createStorageVnextPostgresPlane({ sql: postgresClient }),
    createStorageVnextFilesystemPlane("runtime-secrets"),
    createStorageVnextFilesystemPlane("temporary-files")
  ];
  const result = action === "reset"
    ? await resetStorageVnextOwnedScope({ proof, planes })
    : await bootstrapStorageVnextOwnedScope({ proof, planes });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await Promise.allSettled([
    coordinationClient.isOpen ? coordinationClient.quit() : Promise.resolve(),
    postgresClient.end({ timeout: 5 }),
    objectClient.destroy()
  ]);
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the storage vNext owned-scope command`);
  return value;
}

function assertDatabaseTarget(databaseUrl: string, expectedDatabase: string): void {
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (databaseName !== expectedDatabase) {
    throw new Error("DATABASE_URL does not target the exact run-owned database");
  }
}

function normalizeObjectPrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/gu, "");
  if (!normalized || normalized.includes("..") || normalized.includes("\\")) {
    throw new Error("S3_PREFIX is broad or invalid");
  }
  return normalized;
}

function parseBooleanEnvironment(name: string): boolean {
  const value = process.env[name]?.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
