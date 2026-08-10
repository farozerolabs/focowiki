import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import {
  createS3StorageVnextVersionAwareDeletionProvider,
  createStorageVnextVersionAwareObjectDeletion
} from "../src/storage-vnext/ownership/version-aware-deletion.js";

const endpoint = process.env.FOCOWIKI_TEST_S3_ENDPOINT;
const accessKeyId = process.env.FOCOWIKI_TEST_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.FOCOWIKI_TEST_S3_SECRET_ACCESS_KEY;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  endpoint && accessKeyId && secretAccessKey && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedS3 = hasOwnedTarget ? describe : describe.skip;

describeOwnedS3("storage vNext deletion against real versioned S3-compatible storage", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const bucket = `focowiki-delete-${suffix}`;
  const prefix = `validation/${runOwner ?? "invalid"}/${suffix}`;
  const client = new S3Client({
    endpoint: endpoint ?? "http://127.0.0.1:9000",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: accessKeyId ?? "unused",
      secretAccessKey: secretAccessKey ?? "unused"
    }
  });
  let bucketCreated = false;

  afterAll(async () => {
    if (bucketCreated) {
      await removeAllVersions();
      await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
    }
    client.destroy();
  }, 30_000);

  it("deletes every exact version, marker, and multipart upload while preserving siblings", async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    bucketCreated = true;
    await client.send(new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" }
    }));
    const storageKey = `${prefix}/objects/object-delete`;
    const siblingKey = `${prefix}/objects/object-keep`;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      Body: "version-one"
    }));
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      Body: "version-two"
    }));
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    await client.send(new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: storageKey
    }));
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: siblingKey,
      Body: "keep"
    }));
    let state = "verified";
    const deletion = createStorageVnextVersionAwareObjectDeletion({
      registrations: {
        getRegistration: async () => ({ objectId: "object-delete", storageKey, state }),
        getClosure: async () => ({ referenceCount: 0 }),
        markDeleting: async () => { state = "deleting"; },
        markDeleted: async () => { state = "deleted"; }
      },
      provider: createS3StorageVnextVersionAwareDeletionProvider({
        client,
        bucket,
        prefix
      })
    });

    await expect(deletion.deleteZeroOwner("object-delete")).resolves.toEqual({
      deletedVersions: 2,
      deletedMarkers: 1,
      abortedMultipartUploads: 1
    });
    expect(state).toBe("deleted");
    expect(await exactVersionCount(storageKey)).toBe(0);
    expect(await exactMultipartCount(storageKey)).toBe(0);
    expect(await exactVersionCount(siblingKey)).toBe(1);
  }, 30_000);

  async function exactVersionCount(storageKey: string): Promise<number> {
    const page = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: storageKey
    }));
    return [
      ...(page.Versions ?? []),
      ...(page.DeleteMarkers ?? [])
    ].filter((item) => item.Key === storageKey).length;
  }

  async function exactMultipartCount(storageKey: string): Promise<number> {
    const page = await client.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      Prefix: storageKey
    }));
    return (page.Uploads ?? []).filter((item) => item.Key === storageKey).length;
  }

  async function removeAllVersions(): Promise<void> {
    const page = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket
    })).catch(() => null);
    const objects = [
      ...(page?.Versions ?? []),
      ...(page?.DeleteMarkers ?? [])
    ].flatMap((item) => item.Key && item.VersionId
      ? [{ Key: item.Key, VersionId: item.VersionId }]
      : []);
    if (objects.length > 0) {
      await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects }
      }));
    }
  }
});
