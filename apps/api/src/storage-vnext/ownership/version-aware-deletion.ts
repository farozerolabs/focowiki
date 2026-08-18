import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { isS3VersionListingUnsupported } from "../../storage/s3.js";

const MAX_DELETE_BATCH = 1_000;

export type StorageVnextVersionAwareDeletionResult = {
  deletedVersions: number;
  deletedMarkers: number;
  abortedMultipartUploads: number;
};

export type StorageVnextVersionAwareDeletionProvider = {
  purge(storageKey: string): Promise<StorageVnextVersionAwareDeletionResult>;
};

type RegistrationDeletionPort = {
  getRegistration(objectId: string): Promise<{
    objectId: string;
    storageKey: string;
    state: string;
  } | null>;
  getClosure(objectId: string): Promise<{ referenceCount: number }>;
  markDeleting(objectId: string): Promise<void>;
  markDeleted(objectId: string): Promise<void>;
};

export function createStorageVnextVersionAwareObjectDeletion(input: {
  registrations: RegistrationDeletionPort;
  provider: StorageVnextVersionAwareDeletionProvider;
}) {
  return {
    async deleteZeroOwner(objectId: string): Promise<StorageVnextVersionAwareDeletionResult> {
      const registration = await input.registrations.getRegistration(objectId);
      if (!registration) throw deletionError("object_not_found");
      const before = await input.registrations.getClosure(objectId);
      if (before.referenceCount > 0) throw deletionError("owners_present");
      if (registration.state === "verified") {
        await input.registrations.markDeleting(objectId);
      } else if (registration.state !== "deleting" && registration.state !== "deleted") {
        throw deletionError("state_conflict");
      }
      const result = await input.provider.purge(registration.storageKey);
      const after = await input.registrations.getClosure(objectId);
      if (after.referenceCount > 0) throw deletionError("owners_present");
      await input.registrations.markDeleted(objectId);
      return result;
    }
  };
}

export function createS3StorageVnextVersionAwareDeletionProvider(input: {
  client: S3Client;
  bucket: string;
  prefix: string;
}): StorageVnextVersionAwareDeletionProvider {
  const bucket = requireValue(input.bucket);
  const prefix = requireValue(input.prefix).replace(/\/+$/gu, "");
  return {
    async purge(storageKey) {
      assertOwnedKey(prefix, storageKey);
      const versions = await listExactVersions(input.client, bucket, storageKey);
      if (versions === null) {
        const existed = await headCurrent(input.client, bucket, storageKey);
        if (existed) {
          await input.client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: storageKey
          }));
        }
        const uploads = await abortExactMultipartUploads(
          input.client,
          bucket,
          storageKey
        );
        if (
          await headCurrent(input.client, bucket, storageKey)
          || (await listExactMultipartUploads(input.client, bucket, storageKey)).length > 0
        ) throw deletionError("provider_residue");
        return {
          deletedVersions: existed ? 1 : 0,
          deletedMarkers: 0,
          abortedMultipartUploads: uploads
        };
      }
      const identifiers = versions.map((item) => ({
        Key: storageKey,
        VersionId: item.versionId
      }));
      for (let offset = 0; offset < identifiers.length; offset += MAX_DELETE_BATCH) {
        const batch = identifiers.slice(offset, offset + MAX_DELETE_BATCH);
        const response = await input.client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch, Quiet: false }
        }));
        if ((response.Errors ?? []).length > 0) {
          throw deletionError("provider_delete_failed");
        }
      }
      const uploads = await abortExactMultipartUploads(input.client, bucket, storageKey);
      const remainingVersions = await listExactVersions(input.client, bucket, storageKey);
      const remainingUploads = await listExactMultipartUploads(input.client, bucket, storageKey);
      if (
        remainingVersions === null
        || remainingVersions.length > 0
        || remainingUploads.length > 0
      ) {
        throw deletionError("provider_residue");
      }
      try {
        await input.client.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
        throw deletionError("provider_residue");
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      return {
        deletedVersions: versions.filter((item) => item.kind === "version").length,
        deletedMarkers: versions.filter((item) => item.kind === "marker").length,
        abortedMultipartUploads: uploads
      };
    }
  };
}

export async function validateS3StorageVnextLifecycle(input: {
  client: S3Client;
  bucket: string;
  prefix: string;
  maximumNoncurrentDays: number;
  maximumMultipartDays: number;
}): Promise<{ versioningEnabled: true; lifecycleValid: true }> {
  const bucket = requireValue(input.bucket);
  const prefix = `${requireValue(input.prefix).replace(/\/+$/gu, "")}/`;
  assertPositiveDays(input.maximumNoncurrentDays);
  assertPositiveDays(input.maximumMultipartDays);
  const versioning = await input.client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  if (versioning.Status !== "Enabled") throw deletionError("versioning_unavailable");
  let lifecycle;
  try {
    lifecycle = await input.client.send(new GetBucketLifecycleConfigurationCommand({
      Bucket: bucket
    }));
  } catch {
    throw deletionError("lifecycle_unavailable");
  }
  const valid = (lifecycle.Rules ?? []).some((rule) => {
    if (rule.Status !== "Enabled") return false;
    const rulePrefix = rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix;
    const noncurrentDays = rule.NoncurrentVersionExpiration?.NoncurrentDays;
    const multipartDays = rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation;
    return typeof rulePrefix === "string"
      && prefix.startsWith(rulePrefix)
      && Number.isInteger(noncurrentDays)
      && Number(noncurrentDays) > 0
      && Number(noncurrentDays) <= input.maximumNoncurrentDays
      && rule.Expiration?.ExpiredObjectDeleteMarker === true
      && Number.isInteger(multipartDays)
      && Number(multipartDays) > 0
      && Number(multipartDays) <= input.maximumMultipartDays;
  });
  if (!valid) throw deletionError("lifecycle_invalid");
  return { versioningEnabled: true, lifecycleValid: true };
}

async function listExactVersions(
  client: S3Client,
  bucket: string,
  storageKey: string
): Promise<Array<{ kind: "version" | "marker"; versionId: string }> | null> {
  const results: Array<{ kind: "version" | "marker"; versionId: string }> = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    let page;
    try {
      page = await client.send(new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: storageKey,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {})
      }));
    } catch (error) {
      if (isS3VersionListingUnsupported(error)) return null;
      throw error;
    }
    for (const version of page.Versions ?? []) {
      if (version.Key === storageKey && version.VersionId) {
        results.push({ kind: "version", versionId: version.VersionId });
      }
    }
    for (const marker of page.DeleteMarkers ?? []) {
      if (marker.Key === storageKey && marker.VersionId) {
        results.push({ kind: "marker", versionId: marker.VersionId });
      }
    }
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker) throw deletionError("pagination_incomplete");
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  } while (true);
  return results;
}

async function abortExactMultipartUploads(
  client: S3Client,
  bucket: string,
  storageKey: string
): Promise<number> {
  const uploads = await listExactMultipartUploads(client, bucket, storageKey);
  for (const uploadId of uploads) {
    await client.send(new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: storageKey,
      UploadId: uploadId
    }));
  }
  return uploads.length;
}

async function headCurrent(
  client: S3Client,
  bucket: string,
  storageKey: string
): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function listExactMultipartUploads(
  client: S3Client,
  bucket: string,
  storageKey: string
): Promise<string[]> {
  const results: string[] = [];
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const page = await client.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      Prefix: storageKey,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {})
    }));
    for (const upload of page.Uploads ?? []) {
      if (upload.Key === storageKey && upload.UploadId) results.push(upload.UploadId);
    }
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker) throw deletionError("pagination_incomplete");
    keyMarker = page.NextKeyMarker;
    uploadIdMarker = page.NextUploadIdMarker;
  } while (true);
  return results;
}

function assertOwnedKey(prefix: string, storageKey: string): void {
  if (!storageKey.startsWith(`${prefix}/`) || storageKey.includes("\0")) {
    throw deletionError("scope_conflict");
  }
}

function requireValue(value: string): string {
  if (!value || value.trim() !== value) throw deletionError("invalid_input");
  return value;
}

function assertPositiveDays(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw deletionError("invalid_input");
}

function isMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = "$metadata" in error
    ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
    : undefined;
  return error.name === "NotFound" || error.name === "NoSuchKey" || status === 404;
}

function deletionError(code: string): Error {
  return Object.assign(new Error(`Storage vNext version-aware deletion error: ${code}`), {
    code
  });
}
