import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createUploadSessionStoragePort } from "../src/infrastructure/storage/upload-session-storage.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";

describe("upload session streaming storage", () => {
  it("streams content while computing received bytes and checksum", async () => {
    const storage = new StreamingMemoryStorage();
    const port = createUploadSessionStoragePort(storage);
    const chunks = [new TextEncoder().encode("# Heading\n"), new TextEncoder().encode("Body")];
    const result = await port.putEntry({
      knowledgeBaseId: "kb-stream",
      sessionId: "upload-session-stream",
      entryId: "upload-entry-stream",
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        }
      }),
      declaredSize: 14
    });

    expect(result).toEqual({
      objectKey: "test/knowledge-bases/kb-stream/upload-sessions/upload-session-stream/entries/upload-entry-stream/content.md",
      receivedSize: 14,
      receivedChecksumSha256: "314888e072452e7aa15da1c7680de2aac9cd7c057d910c4c1d41735e3264d682"
    });
    expect(storage.content).toBe("# Heading\nBody");
    expect(storage.contentLength).toBe(14);
  });
});

class StreamingMemoryStorage implements StorageAdapter {
  public readonly keyspace = createStorageKeyspace("test");
  public content = "";
  public contentLength: number | null = null;

  public async putObject(_object: StoredObject): Promise<void> {
    throw new Error("Buffered writes are not expected");
  }

  public async putStreamObject(object: {
    key: string;
    body: Readable;
    contentLength: number;
  }): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.content = Buffer.concat(chunks).toString("utf8");
    this.contentLength = object.contentLength;
  }

  public async getObjectText(): Promise<string | null> {
    return this.content;
  }
}
