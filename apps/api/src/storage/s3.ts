import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig
} from "@aws-sdk/client-s3";
import type { RuntimeConfig } from "../config.js";
import {
  createStorageKeyspace,
  parseCurrentPointer,
  serializeCurrentPointer,
  type CurrentPointer,
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
  getObjectBody?: (key: string) => Promise<BodyInit | null>;
  getObjectText: (key: string, options?: { maxBytes?: number }) => Promise<string | null>;
  writeCurrentPointer: (pointer: CurrentPointer) => Promise<void>;
  readCurrentPointer: () => Promise<CurrentPointer | null>;
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

  public async writeCurrentPointer(pointer: CurrentPointer): Promise<void> {
    await this.putObject({
      key: this.keyspace.currentPointerKey(),
      body: serializeCurrentPointer(pointer),
      contentType: "application/json"
    });
  }

  public async readCurrentPointer(): Promise<CurrentPointer | null> {
    const rawPointer = await this.getObjectText(this.keyspace.currentPointerKey());

    if (!rawPointer) {
      return null;
    }

    return parseCurrentPointer(rawPointer);
  }
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
