import { createHash } from "node:crypto";
import type {
  ImmutableObjectRecord,
  ImmutableObjectRepository
} from "../application/ports/immutable-object-repository.js";
import {
  createImmutableObjectKey,
  PUBLICATION_FORMAT_VERSION
} from "../domain/generation.js";
import type { StorageAdapter } from "../storage/s3.js";

export type ImmutableObjectWriteResult = ImmutableObjectRecord & {
  reused: boolean;
};

export function createImmutableObjectWriter(input: {
  repository: ImmutableObjectRepository;
  storage: Pick<StorageAdapter, "keyspace" | "putObject">;
  now?: (() => Date) | undefined;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async write(object: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number | undefined;
    }): Promise<ImmutableObjectWriteResult> {
      const body = typeof object.body === "string"
        ? Buffer.from(object.body, "utf8")
        : Buffer.from(object.body);
      const checksumSha256 = createHash("sha256").update(body).digest("hex");
      const formatVersion = object.formatVersion ?? PUBLICATION_FORMAT_VERSION;
      const objectKey = createImmutableObjectKey({
        prefix: input.storage.keyspace.prefix,
        checksumSha256,
        formatVersion
      });
      const existing = await input.repository.find({ checksumSha256, formatVersion });
      if (existing) {
        assertRegisteredObject(existing, {
          objectKey,
          contentType: object.contentType,
          sizeBytes: body.byteLength
        });
        return { ...existing, reused: true };
      }

      await input.storage.putObject({
        key: objectKey,
        body,
        contentType: object.contentType,
        cacheControl: "public, max-age=31536000, immutable"
      });
      const registered = await input.repository.register({
        checksumSha256,
        formatVersion,
        objectKey,
        contentType: object.contentType,
        sizeBytes: body.byteLength,
        verifiedAt: now().toISOString()
      });
      return { ...registered, reused: false };
    }
  };
}

function assertRegisteredObject(
  existing: ImmutableObjectRecord,
  expected: { objectKey: string; contentType: string; sizeBytes: number }
): void {
  if (
    existing.objectKey !== expected.objectKey
    || existing.contentType !== expected.contentType
    || existing.sizeBytes !== expected.sizeBytes
  ) {
    throw new Error("Immutable object identity conflicts with registered metadata");
  }
}
