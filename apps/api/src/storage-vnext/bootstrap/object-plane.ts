import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { isS3VersionListingUnsupported } from "../../storage/s3.js";
import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";
import type {
  StorageVnextOwnedPlaneInspection,
  StorageVnextResetBootstrapPlane
} from "./command.js";
import { parseStorageVnextOwnerMarker } from "./owner-marker.js";
import { StorageVnextOwnedScopeError, validateStorageVnextOwnedScopeProof } from "./owned-scope.js";
import { assertStorageVnextOwnedPlane } from "./plane-safety.js";

type VersionEntry = {
  key: string;
  versionId: string | null;
  isLatest: boolean;
  deleteMarker: boolean;
};

type MultipartEntry = {
  key: string;
  uploadId: string;
};

type ObjectInventory = {
  versions: VersionEntry[];
  multipartUploads: MultipartEntry[];
  unexpectedTargets: string[];
};

export function createStorageVnextObjectPlane(input: {
  client: S3Client;
  bucket: string;
}): StorageVnextResetBootstrapPlane {
  return {
    plane: "object",
    inspect: (proof) => inspectObjectScope(input, proof),
    async reset(proof) {
      const inspection = await inspectObjectScope(input, proof);
      assertStorageVnextOwnedPlane(inspection, proof, "object", proof.objectScope);
      const markerKey = ownerMarkerKey(proof);
      const inventory = await inventoryObjectScope(input, proof.objectScope);
      if (inventory.unexpectedTargets.length > 0) {
        throw new StorageVnextOwnedScopeError("S3 inventory escaped the exact owned prefix");
      }

      const deletableVersions = inventory.versions.filter(
        (entry) => !(entry.key === markerKey && entry.isLatest && !entry.deleteMarker)
      );
      for (const chunk of chunks(deletableVersions, 1_000)) {
        const result = await input.client.send(new DeleteObjectsCommand({
          Bucket: input.bucket,
          Delete: {
            Objects: chunk.map((entry) => ({
              Key: entry.key,
              ...(entry.versionId ? { VersionId: entry.versionId } : {})
            })),
            Quiet: true
          }
        }));
        if ((result.Errors?.length ?? 0) > 0) {
          throw new StorageVnextOwnedScopeError("S3 rejected an exact owned version deletion");
        }
      }

      for (const upload of inventory.multipartUploads) {
        await input.client.send(new AbortMultipartUploadCommand({
          Bucket: input.bucket,
          Key: upload.key,
          UploadId: upload.uploadId
        }));
      }
    },
    async verifyReset(proof) {
      const inspection = await inspectObjectScope(input, proof);
      return isOwnedObject(inspection, proof) && inspection.bootstrapState === "current";
    },
    async bootstrap(proof) {
      const inspection = await inspectObjectScope(input, proof);
      assertStorageVnextOwnedPlane(inspection, proof, "object", proof.objectScope);
      if (inspection.bootstrapState === "incompatible") {
        throw new StorageVnextOwnedScopeError("Owned S3 prefix is not clean");
      }
    },
    async verifyBootstrap(proof) {
      const inspection = await inspectObjectScope(input, proof);
      return isOwnedObject(inspection, proof) && inspection.bootstrapState === "current";
    }
  };
}

async function inspectObjectScope(
  input: { client: S3Client; bucket: string },
  candidateProof: StorageVnextOwnedScopeProof
): Promise<StorageVnextOwnedPlaneInspection> {
  const proof = validateStorageVnextOwnedScopeProof(candidateProof);
  const markerValue = await readOwnerMarker(input, ownerMarkerKey(proof));
  const marker = markerValue
    ? parseStorageVnextOwnerMarker(markerValue, proof, proof.objectScope)
    : null;
  const inventory = await inventoryObjectScope(input, proof.objectScope);
  const markerKey = ownerMarkerKey(proof);
  const currentMarkers = inventory.versions.filter(
    (entry) => entry.key === markerKey && entry.isLatest && !entry.deleteMarker
  );
  const productVersions = inventory.versions.filter(
    (entry) => !(entry.key === markerKey && entry.isLatest && !entry.deleteMarker)
  );
  const clean = currentMarkers.length === 1
    && productVersions.length === 0
    && inventory.multipartUploads.length === 0;

  return {
    plane: "object",
    target: proof.objectScope,
    exists: markerValue !== null,
    createdByRun: marker?.createdByRun ?? false,
    existedBeforeRun: marker?.existedBeforeRun ?? true,
    broadTarget: !proof.objectScope.endsWith("/") || proof.objectScope === "/",
    bootstrapState: clean ? "current" : "incompatible",
    ownerMarker: marker?.ownerMarker ?? null,
    unexpectedTargets: inventory.unexpectedTargets
  };
}

async function inventoryObjectScope(
  input: { client: S3Client; bucket: string },
  prefix: string
): Promise<ObjectInventory> {
  const versions: VersionEntry[] = [];
  const multipartUploads: MultipartEntry[] = [];
  const unexpectedTargets: string[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  try {
    do {
      const page = await input.client.send(new ListObjectVersionsCommand({
        Bucket: input.bucket,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
        MaxKeys: 1_000
      }));
      for (const entry of page.Versions ?? []) {
        if (!entry.Key || !entry.VersionId) continue;
        if (!entry.Key.startsWith(prefix)) unexpectedTargets.push(entry.Key);
        versions.push({
          key: entry.Key,
          versionId: entry.VersionId,
          isLatest: entry.IsLatest === true,
          deleteMarker: false
        });
      }
      for (const entry of page.DeleteMarkers ?? []) {
        if (!entry.Key || !entry.VersionId) continue;
        if (!entry.Key.startsWith(prefix)) unexpectedTargets.push(entry.Key);
        versions.push({
          key: entry.Key,
          versionId: entry.VersionId,
          isLatest: entry.IsLatest === true,
          deleteMarker: true
        });
      }
      if (page.IsTruncated && !page.NextKeyMarker) {
        throw new StorageVnextOwnedScopeError("S3 version inventory pagination is incomplete");
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);
  } catch (error) {
    if (!isS3VersionListingUnsupported(error) || versions.length > 0) throw error;
    let continuationToken: string | undefined;
    do {
      const page = await input.client.send(new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1_000
      }));
      for (const entry of page.Contents ?? []) {
        if (!entry.Key) continue;
        if (!entry.Key.startsWith(prefix)) unexpectedTargets.push(entry.Key);
        versions.push({
          key: entry.Key,
          versionId: null,
          isLatest: true,
          deleteMarker: false
        });
      }
      if (page.IsTruncated && !page.NextContinuationToken) {
        throw new StorageVnextOwnedScopeError("S3 object inventory pagination is incomplete");
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  let uploadKeyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const page = await input.client.send(new ListMultipartUploadsCommand({
      Bucket: input.bucket,
      Prefix: prefix,
      KeyMarker: uploadKeyMarker,
      UploadIdMarker: uploadIdMarker,
      MaxUploads: 1_000
    }));
    for (const upload of page.Uploads ?? []) {
      if (!upload.Key || !upload.UploadId) continue;
      if (!upload.Key.startsWith(prefix)) unexpectedTargets.push(upload.Key);
      multipartUploads.push({ key: upload.Key, uploadId: upload.UploadId });
    }
    if (page.IsTruncated && (!page.NextKeyMarker || !page.NextUploadIdMarker)) {
      throw new StorageVnextOwnedScopeError("S3 multipart inventory pagination is incomplete");
    }
    uploadKeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (uploadKeyMarker);

  return {
    versions,
    multipartUploads,
    unexpectedTargets: [...new Set(unexpectedTargets)].sort()
  };
}

async function readOwnerMarker(
  input: { client: S3Client; bucket: string },
  key: string
): Promise<string | null> {
  try {
    const response = await input.client.send(new GetObjectCommand({
      Bucket: input.bucket,
      Key: key
    }));
    if (!response.Body) return null;
    return await response.Body.transformToString("utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function ownerMarkerKey(proof: StorageVnextOwnedScopeProof): string {
  return `${proof.objectScope}_run-owner.json`;
}

function isOwnedObject(
  inspection: StorageVnextOwnedPlaneInspection,
  proof: StorageVnextOwnedScopeProof
): boolean {
  try {
    assertStorageVnextOwnedPlane(inspection, proof, "object", proof.objectScope);
    return true;
  } catch {
    return false;
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (
      ("name" in error && (error.name === "NoSuchKey" || error.name === "NotFound"))
      || ("$metadata" in error
        && typeof error.$metadata === "object"
        && error.$metadata !== null
        && "httpStatusCode" in error.$metadata
        && error.$metadata.httpStatusCode === 404)
    );
}
