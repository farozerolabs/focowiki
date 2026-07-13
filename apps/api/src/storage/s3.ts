import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig
} from "@aws-sdk/client-s3";
import type { RuntimeConfig } from "../config.js";
import {
  createStorageKeyspace,
  type StorageKeyspace
} from "./keys.js";

export type StoredObject = {
  key: string;
  body: string | Uint8Array;
  contentType?: string;
  cacheControl?: string;
};

export class StorageObjectTooLargeError extends Error {
  public readonly key: string;
  public readonly sizeBytes: number;
  public readonly maxBytes: number;

  public constructor(input: { key: string; sizeBytes: number; maxBytes: number }) {
    super("Storage object exceeds the configured read limit.");
    this.name = "StorageObjectTooLargeError";
    this.key = input.key;
    this.sizeBytes = input.sizeBytes;
    this.maxBytes = input.maxBytes;
  }
}

export type StorageAdapter = {
  readonly keyspace: StorageKeyspace;
  putObject: (object: StoredObject) => Promise<void>;
  copyObject?: (input: { sourceKey: string; destinationKey: string }) => Promise<void>;
  listObjectKeys?: (input: {
    prefix: string;
    continuationToken?: string | null;
    limit: number;
  }) => Promise<{ keys: string[]; nextContinuationToken: string | null }>;
  deleteObject?: (key: string) => Promise<void>;
  deleteObjects?: (keys: string[]) => Promise<void>;
  deleteObjectVersions?: (keys: string[]) => Promise<void>;
  purgePrefix?: (prefix: string) => Promise<{ deleted: number; remaining: number }>;
  countPrefix?: (prefix: string) => Promise<number>;
  getObjectBody?: (key: string) => Promise<BodyInit | null>;
  getObjectText: (key: string, options?: { maxBytes?: number }) => Promise<string | null>;
};

type S3StorageOptions = {
  client?: S3Client;
  bucket: string;
  keyspace: StorageKeyspace;
};

export function createS3ClientConfig(
  storage: RuntimeConfig["storage"]
): S3ClientConfig {
  return {
    endpoint: storage.endpoint,
    region: storage.region,
    credentials: {
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey
    },
    forcePathStyle: storage.forcePathStyle
  };
}

export function createS3StorageAdapter(
  storage: RuntimeConfig["storage"],
  client = new S3Client(createS3ClientConfig(storage))
): StorageAdapter {
  return new S3StorageAdapter({
    client,
    bucket: storage.bucket,
    keyspace: createStorageKeyspace(storage.prefix)
  });
}

export class S3StorageAdapter implements StorageAdapter {
  public readonly keyspace: StorageKeyspace;

  private readonly bucket: string;
  private readonly client: S3Client;

  public constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.client = options.client ?? new S3Client({});
    this.keyspace = options.keyspace;
  }

  public async putObject(object: StoredObject): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: object.key,
        Body: object.body,
        ...(object.contentType ? { ContentType: object.contentType } : {}),
        ...(object.cacheControl ? { CacheControl: object.cacheControl } : {})
      })
    );
  }

  public async copyObject(input: { sourceKey: string; destinationKey: string }): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${encodeURIComponent(this.bucket)}/${input.sourceKey
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        Key: input.destinationKey,
        MetadataDirective: "COPY"
      })
    );
  }

  public async listObjectKeys(input: {
    prefix: string;
    continuationToken?: string | null;
    limit: number;
  }): Promise<{ keys: string[]; nextContinuationToken: string | null }> {
    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: input.prefix,
        ContinuationToken: input.continuationToken ?? undefined,
        MaxKeys: Math.min(Math.max(input.limit, 1), 1_000)
      })
    );

    return {
      keys: (response.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key)),
      nextContinuationToken: response.NextContinuationToken ?? null
    };
  }

  public async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );
  }

  public async deleteObjects(keys: string[]): Promise<void> {
    for (const chunk of chunkArray(uniqueKeys(keys), 1_000)) {
      if (chunk.length === 0) {
        continue;
      }

      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: chunk.map((key) => ({ Key: key })),
            Quiet: true
          }
        })
      );
    }
  }

  public async deleteObjectVersions(keys: string[]): Promise<void> {
    for (const key of uniqueKeys(keys)) {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;

      do {
        const listed = await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            Prefix: key,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker
          })
        );
        const versionedObjects = [
          ...(listed.Versions ?? []),
          ...(listed.DeleteMarkers ?? [])
        ]
          .filter((version) => version.Key === key && version.VersionId)
          .map((version) => ({
            Key: key,
            VersionId: version.VersionId
          }));

        for (const chunk of chunkArray(versionedObjects, 1_000)) {
          if (chunk.length === 0) {
            continue;
          }

          await this.client.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: {
                Objects: chunk,
                Quiet: true
              }
            })
          );
        }

        keyMarker = listed.NextKeyMarker;
        versionIdMarker = listed.NextVersionIdMarker;
      } while (keyMarker);
    }
  }

  public async purgePrefix(prefix: string): Promise<{ deleted: number; remaining: number }> {
    let deleted = 0;
    try {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;

      do {
        const listed = await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            Prefix: prefix,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker
          })
        );
        const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
          .filter((entry): entry is typeof entry & { Key: string; VersionId: string } =>
            Boolean(entry.Key && entry.VersionId)
          )
          .map((entry) => ({ Key: entry.Key, VersionId: entry.VersionId }));

        for (const chunk of chunkArray(objects, 1_000)) {
          await this.client.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: { Objects: chunk, Quiet: true }
            })
          );
          deleted += chunk.length;
        }

        keyMarker = listed.IsTruncated ? listed.NextKeyMarker : undefined;
        versionIdMarker = listed.IsTruncated ? listed.NextVersionIdMarker : undefined;
      } while (keyMarker);
    } catch (error) {
      if (!isVersionListingUnsupported(error)) {
        throw error;
      }
    }

    let continuationToken: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1_000
        })
      );
      const keys = (listed.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((key): key is string => Boolean(key));

      for (const chunk of chunkArray(keys, 1_000)) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true }
          })
        );
        deleted += chunk.length;
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);

    return { deleted, remaining: await this.countPrefix(prefix) };
  }

  public async countPrefix(prefix: string): Promise<number> {
    const verification = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1 })
    );
    try {
      const versionVerification = await this.client.send(
        new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1 })
      );
      return (verification.Contents?.length ?? 0) +
        (versionVerification.Versions?.length ?? 0) +
        (versionVerification.DeleteMarkers?.length ?? 0);
    } catch (error) {
      if (!isVersionListingUnsupported(error)) {
        throw error;
      }
      return verification.Contents?.length ?? 0;
    }
  }

  public async getObjectText(
    key: string,
    options: { maxBytes?: number } = {}
  ): Promise<string | null> {
    try {
      if (options.maxBytes) {
        const head = await this.client.send(
          new HeadObjectCommand({
            Bucket: this.bucket,
            Key: key
          })
        );
        const sizeBytes = head.ContentLength ?? 0;

        if (sizeBytes > options.maxBytes) {
          throw new StorageObjectTooLargeError({
            key,
            sizeBytes,
            maxBytes: options.maxBytes
          });
        }
      }

      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key
        })
      );

      return await responseBodyToString(response.Body);
    } catch (error) {
      if (error instanceof NoSuchKey || isNoSuchKeyError(error)) {
        return null;
      }

      throw error;
    }
  }

  public async getObjectBody(key: string): Promise<BodyInit | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key
        })
      );

      return responseBodyToBodyInit(response.Body);
    } catch (error) {
      if (error instanceof NoSuchKey || isNoSuchKeyError(error)) {
        return null;
      }

      throw error;
    }
  }

}

function isVersionListingUnsupported(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return candidate.name === "NotImplemented"
    || candidate.Code === "NotImplemented"
    || candidate.$metadata?.httpStatusCode === 501;
}

function uniqueKeys(keys: string[]): string[] {
  return [...new Set(keys.filter((key) => key.length > 0))];
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function responseBodyToBodyInit(body: unknown): BodyInit {
  if (!body) {
    return "";
  }

  if (typeof body === "string" || body instanceof ReadableStream) {
    return body;
  }

  if (body instanceof Uint8Array) {
    return new Blob([uint8ArrayToArrayBuffer(body)]);
  }

  const streamBody = body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
  };

  if (typeof streamBody.transformToWebStream === "function") {
    return streamBody.transformToWebStream();
  }

  if (typeof streamBody[Symbol.asyncIterator] === "function") {
    const iterable = streamBody as AsyncIterable<Uint8Array | string>;
    const iterator = iterable[Symbol.asyncIterator]();

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();

        if (next.done) {
          controller.close();
          return;
        }

        controller.enqueue(
          typeof next.value === "string" ? new TextEncoder().encode(next.value) : next.value
        );
      }
    });
  }

  throw new TypeError("Unsupported S3 response body");
}

function uint8ArrayToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function responseBodyToString(body: unknown): Promise<string> {
  if (!body) {
    return "";
  }

  if (typeof body === "string") {
    return body;
  }

  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }

  const streamBody = body as {
    transformToString?: () => Promise<string>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
  };

  if (typeof streamBody.transformToString === "function") {
    return streamBody.transformToString();
  }

  if (typeof streamBody[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];

    for await (const chunk of streamBody as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    }

    return new TextDecoder().decode(concatUint8Arrays(chunks));
  }

  throw new TypeError("Unsupported S3 response body");
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

function isNoSuchKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "NoSuchKey"
  );
}
