import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { UploadSessionStoragePort } from "../../application/ports/upload-session-storage.js";
import type { StorageAdapter } from "../../storage/s3.js";

export function createUploadSessionStoragePort(
  storage: StorageAdapter
): UploadSessionStoragePort {
  return {
    async putEntry(input) {
      const objectKey = storage.keyspace.uploadSessionEntryKey(
        input.knowledgeBaseId,
        input.sessionId,
        input.entryId
      );
      const hash = createHash("sha256");
      let receivedSize = 0;
      const verifier = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          receivedSize += chunk.byteLength;
          hash.update(chunk);
          callback(null, chunk);
        }
      });
      if (!storage.putStreamObject) {
        throw new Error("Streaming upload storage is unavailable");
      }
      const body = Readable.from(readWebStream(input.body)).pipe(verifier);
      await storage.putStreamObject({
        key: objectKey,
        body,
        contentLength: input.declaredSize,
        contentType: "text/markdown; charset=utf-8"
      });
      return {
        objectKey,
        receivedSize,
        receivedChecksumSha256: hash.digest("hex")
      };
    },
    async deleteObject(objectKey) {
      await storage.deleteObject?.(objectKey);
    },
    async deleteObjects(objectKeys) {
      if (objectKeys.length === 0) return;
      if (storage.deleteObjects) {
        await storage.deleteObjects(objectKeys);
        return;
      }
      await Promise.all(objectKeys.map((objectKey) => storage.deleteObject?.(objectKey)));
    }
  };
}

async function* readWebStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Buffer> {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      yield Buffer.from(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}
