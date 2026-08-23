import { S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createS3StorageAdapter,
  createS3ClientConfig
} from "../src/storage/s3.js";
import { areContentTypesEquivalent } from "../src/storage/content-type.js";
import { writeStorageVnextUploadBody } from
  "../src/storage-vnext/api/admin-upload-body-writer.js";
import { createS3StorageVnextSourceBodyStore } from
  "../src/storage-vnext/catalog/s3-source-body-store.js";
import { createS3StorageVnextImmutableBodyStore } from
  "../src/storage-vnext/ownership/s3-immutable-body-store.js";
import { createS3StorageVnextObjectInventory } from
  "../src/storage-vnext/ownership/s3-object-inventory.js";
import type { StorageVnextOwnershipRepository } from
  "../src/storage-vnext/ownership/ports.js";
import { createS3StorageVnextVersionAwareDeletionProvider } from
  "../src/storage-vnext/ownership/version-aware-deletion.js";

const runOwner = process.env.FOCOWIKI_TEST_EXTERNAL_S3_RUN_OWNER;
const requiredEnvironment = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_PREFIX",
  "S3_FORCE_PATH_STYLE"
] as const;
const externalEnabled = process.env.FOCOWIKI_TEST_EXTERNAL_S3 === "true"
  && /^s3compat-[a-z0-9]{8,24}$/u.test(runOwner ?? "")
  && requiredEnvironment.every((key) => Boolean(process.env[key]));
const describeExternal = externalEnabled ? describe : describe.skip;

describeExternal("external S3-compatible storage contract", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const configuredPrefix = process.env.S3_PREFIX ?? "disabled";
  const prefix = `${configuredPrefix}/compatibility/${runOwner ?? "disabled"}-${suffix}`;
  const storageConfig = {
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: process.env.S3_BUCKET ?? "disabled",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "disabled",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "disabled",
    prefix,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true"
  };
  const client = new S3Client(createS3ClientConfig(storageConfig));
  const storage = createS3StorageAdapter(storageConfig, client);

  afterAll(async () => {
    try {
      await storage.purgePrefix(`${prefix}/`);
      expect(await storage.countPrefix(`${prefix}/`)).toBe(0);
    } finally {
      client.destroy();
    }
  }, 60_000);

  it("creates, reads, updates, lists, copies, and deletes objects", async () => {
    const objectKey = `${prefix}/crud/document.md`;
    const copiedKey = `${prefix}/crud/document-copy.md`;

    await expect(storage.checkHealth()).resolves.toBeUndefined();
    await storage.putObject({
      key: objectKey,
      body: "first body",
      contentType: "text/markdown; charset=utf-8",
      metadata: { "contract-state": "created" }
    });
    await expect(storage.getObjectText(objectKey)).resolves.toBe("first body");
    const createdMetadata = await storage.headObjectMetadata(objectKey);
    expect(createdMetadata).toMatchObject({
      key: objectKey,
      sizeBytes: 10,
      metadata: { "contract-state": "created" }
    });
    expect(areContentTypesEquivalent(
      createdMetadata?.contentType,
      "text/markdown; charset=utf-8"
    )).toBe(true);
    await expect(storage.listObjectKeys({
      prefix: `${prefix}/crud/`,
      limit: 10
    })).resolves.toMatchObject({ keys: [objectKey] });

    await storage.putObject({
      key: objectKey,
      body: "updated body",
      contentType: "text/markdown; charset=utf-8",
      metadata: { "contract-state": "updated" }
    });
    await expect(storage.getObjectText(objectKey)).resolves.toBe("updated body");
    await expect(storage.headObjectMetadata(objectKey)).resolves.toMatchObject({
      sizeBytes: 12,
      metadata: { "contract-state": "updated" }
    });

    await storage.copyObject({ sourceKey: objectKey, destinationKey: copiedKey });
    await expect(storage.getObjectText(copiedKey)).resolves.toBe("updated body");
    await expect(storage.headObjectMetadata(copiedKey)).resolves.toMatchObject({
      metadata: { "contract-state": "updated" }
    });

    await storage.deleteObject(copiedKey);
    await storage.deleteObjects([objectKey]);
    await expect(storage.getObjectText(copiedKey)).resolves.toBeNull();
    await expect(storage.getObjectText(objectKey)).resolves.toBeNull();
    await expect(storage.listObjectKeys({
      prefix: `${prefix}/crud/`,
      limit: 10
    })).resolves.toMatchObject({ keys: [] });
  }, 60_000);

  it("stores, reuses, verifies, reads, and purges an immutable source body", async () => {
    const sourceStore = createS3StorageVnextSourceBodyStore({
      client,
      bucket: storageConfig.bucket,
      prefix
    });
    const bytes = new TextEncoder().encode("# External S3 compatibility\n\n中文内容。\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const first = await sourceStore.putVerifiedStream({
      body: chunks(bytes, 7),
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8"
    });
    const second = await sourceStore.putVerified({
      bytes,
      contentType: "text/markdown; charset=utf-8"
    });

    expect(first).toMatchObject({ outcome: "stored", checksum });
    expect(second).toMatchObject({ outcome: "reused", objectId: first.objectId });
    const stream = await sourceStore.readVerifiedStream({
      objectId: first.objectId,
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      maxBytes: 1_024
    });
    const readChunks: Uint8Array[] = [];
    for await (const chunk of stream) readChunks.push(chunk);
    expect(Buffer.concat(readChunks.map((chunk) => Buffer.from(chunk))))
      .toEqual(Buffer.from(bytes));

    await expect(createS3StorageVnextVersionAwareDeletionProvider({
      client,
      bucket: storageConfig.bucket,
      prefix
    }).purge(first.storageKey)).resolves.toMatchObject({
      deletedMarkers: 0,
      abortedMultipartUploads: 0
    });
    await expect(storage.headObjectMetadata(first.storageKey)).resolves.toBeNull();
  }, 60_000);

  it("completes a burst larger than the shared socket capacity", async () => {
    const bodyStore = createS3StorageVnextImmutableBodyStore({
      client,
      bucket: storageConfig.bucket,
      prefix
    });
    const objects = Array.from({ length: 96 }, (_, index) => {
      const bytes = new TextEncoder().encode(`bounded-object-${index}`);
      return {
        bytes,
        descriptor: bodyStore.describe({
          bytes,
          objectFormat: "okf-generated-json-v1"
        })
      };
    });

    await Promise.all(objects.map(({ descriptor, bytes }) =>
      bodyStore.putVerified({ descriptor, bytes })));
    const reads = await Promise.all(objects.map(({ descriptor }) =>
      bodyStore.readVerified({ descriptor, maximumBytes: 1_024 })));

    expect(reads).toHaveLength(96);
    expect(reads.every((bytes) => bytes.byteLength > 0)).toBe(true);
  }, 60_000);

  it("streams an admin upload through copy, verification, and temporary cleanup", async () => {
    const body = Buffer.from("# External admin upload compatibility\n", "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const storageKey = `${prefix}/admin-upload/${checksum}.md`;
    const result = await writeStorageVnextUploadBody({
      s3: client,
      bucket: storageConfig.bucket,
      prefix,
      registrations: {
        async reserve(
          reservation: Parameters<StorageVnextOwnershipRepository["reserve"]>[0]
        ) {
          return {
            outcome: "reserved" as const,
            registration: {
              ...reservation,
              state: "reserved" as const,
              verifiedAt: null,
              zeroOwnerSince: null
            }
          };
        },
        async markVerified(
          verified: Parameters<StorageVnextOwnershipRepository["markVerified"]>[0]
        ) {
          return {
            objectId: verified.objectId,
            storageKey,
            checksum,
            byteCount: body.byteLength,
            contentType: "text/markdown; charset=utf-8",
            format: "source-markdown-v1",
            state: "verified" as const,
            writeAttemptPublicId: verified.writeAttemptPublicId,
            verifiedAt: verified.verifiedAt,
            zeroOwnerSince: verified.verifiedAt,
            createdAt: verified.verifiedAt
          };
        }
      } as never,
      compensation: { async compensate() { return "deleted" as const; } },
      describeSource: () => ({
        objectId: `source-sha256:${checksum}`,
        storageKey,
        checksum,
        byteCount: body.byteLength,
        contentType: "text/markdown; charset=utf-8",
        objectFormat: "source-markdown-v1"
      }),
      request: {
        knowledgeBaseId: "knowledge-base-external-s3",
        sessionId: `upload-session-${suffix}`,
        entryId: `upload-entry-${suffix}`,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          }
        })
      },
      entry: {
        upload_session_public_id: `upload-session-${suffix}`,
        entry_public_id: `upload-entry-${suffix}`,
        source_file_public_id: `source-file-${suffix}`,
        logical_path: "external-upload.md",
        normalized_path: "external-upload.md",
        checksum_sha256: checksum,
        byte_count: body.byteLength,
        object_id: null,
        state: "pending",
        existing_resource_revision: null
      }
    });

    expect(result).toMatchObject({ storageKey, checksum, byteCount: body.byteLength });
    await expect(storage.getObjectText(storageKey)).resolves.toBe(body.toString("utf8"));
    await expect(createS3StorageVnextVersionAwareDeletionProvider({
      client,
      bucket: storageConfig.bucket,
      prefix
    }).purge(storageKey)).resolves.toMatchObject({
      abortedMultipartUploads: 0
    });
  }, 60_000);

  it("inventories current objects even when version inventory is unavailable", async () => {
    const objectKey = `${prefix}/inventory/current.md`;
    await storage.putObject({ key: objectKey, body: "inventory" });
    const inventory = createS3StorageVnextObjectInventory({
      client,
      bucket: storageConfig.bucket,
      prefix
    });
    const items: Array<{ kind: string; storageKey: string }> = [];
    let cursor: string | null = null;
    do {
      const page = await inventory.listPage({ limit: 10, cursor });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    expect(items).toContainEqual(expect.objectContaining({
      kind: "current",
      storageKey: objectKey
    }));
  }, 60_000);
});

async function* chunks(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.slice(offset, Math.min(offset + size, bytes.byteLength));
  }
}
