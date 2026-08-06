import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(import.meta.dirname, "../../apps/api/package.json"));
const {
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand
} = require("@aws-sdk/client-s3");

export async function writeS3VersionInventory(input) {
  const summary = {
    currentObjectCount: 0,
    currentBytes: 0,
    noncurrentVersionCount: 0,
    noncurrentBytes: 0,
    deleteMarkerCount: 0,
    multipartUploadCount: 0
  };
  let keyMarker;
  let versionIdMarker;

  try {
    do {
      const page = await input.client.send(new ListObjectVersionsCommand({
        Bucket: input.bucket,
        Prefix: input.prefix,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {})
      }));
      for (const version of page.Versions ?? []) {
        const size = Number(version.Size ?? 0);
        const current = version.IsLatest === true;
        if (current) {
          summary.currentObjectCount += 1;
          summary.currentBytes += size;
        } else {
          summary.noncurrentVersionCount += 1;
          summary.noncurrentBytes += size;
        }
        await input.write({
          kind: "version",
          key: version.Key ?? "",
          versionId: version.VersionId ?? null,
          isLatest: current,
          size,
          etag: version.ETag ?? null,
          lastModified: toIsoString(version.LastModified),
          storageClass: version.StorageClass ?? null
        });
      }
      for (const marker of page.DeleteMarkers ?? []) {
        summary.deleteMarkerCount += 1;
        await input.write({
          kind: "delete-marker",
          key: marker.Key ?? "",
          versionId: marker.VersionId ?? null,
          isLatest: marker.IsLatest === true,
          lastModified: toIsoString(marker.LastModified)
        });
      }
      if (page.IsTruncated) {
        if (!page.NextKeyMarker) {
          throw new Error("S3 version inventory pagination did not return a key marker");
        }
        keyMarker = page.NextKeyMarker;
        versionIdMarker = page.NextVersionIdMarker;
      } else {
        keyMarker = undefined;
        versionIdMarker = undefined;
      }
    } while (keyMarker);
  } catch (error) {
    if (!isVersionListingUnsupported(error) || hasVersionInventory(summary)) throw error;
    let continuationToken;
    do {
      const page = await input.client.send(new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {})
      }));
      for (const object of page.Contents ?? []) {
        const size = Number(object.Size ?? 0);
        summary.currentObjectCount += 1;
        summary.currentBytes += size;
        await input.write({
          kind: "version",
          key: object.Key ?? "",
          versionId: null,
          isLatest: true,
          size,
          etag: object.ETag ?? null,
          lastModified: toIsoString(object.LastModified),
          storageClass: object.StorageClass ?? null
        });
      }
      if (page.IsTruncated && !page.NextContinuationToken) {
        throw new Error("S3 object inventory pagination did not return a continuation token");
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  let uploadKeyMarker;
  let uploadIdMarker;
  do {
    const page = await input.client.send(new ListMultipartUploadsCommand({
      Bucket: input.bucket,
      Prefix: input.prefix,
      ...(uploadKeyMarker ? { KeyMarker: uploadKeyMarker } : {}),
      ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {})
    }));
    for (const upload of page.Uploads ?? []) {
      summary.multipartUploadCount += 1;
      await input.write({
        kind: "multipart-upload",
        key: upload.Key ?? "",
        uploadId: upload.UploadId ?? null,
        initiated: toIsoString(upload.Initiated),
        storageClass: upload.StorageClass ?? null
      });
    }
    if (page.IsTruncated) {
      if (!page.NextKeyMarker || !page.NextUploadIdMarker) {
        throw new Error("S3 multipart inventory pagination did not return continuation markers");
      }
      uploadKeyMarker = page.NextKeyMarker;
      uploadIdMarker = page.NextUploadIdMarker;
    } else {
      uploadKeyMarker = undefined;
      uploadIdMarker = undefined;
    }
  } while (uploadKeyMarker);

  return summary;
}

function hasVersionInventory(summary) {
  return summary.currentObjectCount > 0
    || summary.noncurrentVersionCount > 0
    || summary.deleteMarkerCount > 0;
}

function isVersionListingUnsupported(error) {
  return error && typeof error === "object" && (
    ["NotImplemented", "MethodNotAllowed", "UnsupportedOperation"].includes(error.name)
    || ["NotImplemented", "MethodNotAllowed", "UnsupportedOperation"].includes(error.Code)
    || error.$metadata?.httpStatusCode === 501
    || error.$metadata?.httpStatusCode === 405
  );
}

export async function backupAuthorityObjects(input) {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  let objectCount = 0;
  let byteCount = 0;

  for await (const object of input.objects) {
    const backupFile = `${createHash("sha256").update(object.objectId).digest("hex")}.blob`;
    const target = resolve(input.directory, backupFile);
    const temporary = `${target}.partial`;
    const response = await input.client.send(new GetObjectCommand({
      Bucket: input.bucket,
      Key: object.storageKey
    }));
    if (!response.Body || typeof response.Body[Symbol.asyncIterator] !== "function") {
      throw new Error(`S3 authority object body is unavailable for ${object.objectId}`);
    }
    if (
      typeof response.ContentType !== "string"
      || !response.ContentType
      || !isStringRecord(response.Metadata)
    ) {
      throw new Error(`S3 authority object metadata is unavailable for ${object.objectId}`);
    }

    const hash = createHash("sha256");
    let actualBytes = 0;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        for await (const chunk of response.Body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          hash.update(buffer);
          actualBytes += buffer.length;
          await handle.writeFile(buffer);
        }
      } finally {
        await handle.close();
      }

      const actualChecksum = hash.digest("hex");
      if (actualBytes !== object.byteCount || actualChecksum !== object.checksumSha256) {
        throw new Error(`S3 authority object verification failed for ${object.objectId}`);
      }
      await rename(temporary, target);
      await input.write({
        ...object,
        backupFile,
        versionId: response.VersionId ?? null,
        etag: response.ETag ?? null,
        contentType: response.ContentType,
        metadata: response.Metadata
      });
    } catch (error) {
      await rm(temporary, { force: true });
      await rm(target, { force: true });
      throw error;
    }
    objectCount += 1;
    byteCount += actualBytes;
  }

  return { objectCount, byteCount };
}

function isStringRecord(value) {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) =>
      key.length > 0 && typeof item === "string");
}

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : null;
}
