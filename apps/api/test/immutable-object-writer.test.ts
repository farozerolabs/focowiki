import { describe, expect, it, vi } from "vitest";
import type { ImmutableObjectRepository } from "../src/application/ports/immutable-object-repository.js";
import { createImmutableObjectWriter } from "../src/publication/immutable-object-writer.js";
import { createStorageKeyspace } from "../src/storage/keys.js";

describe("immutable object writer", () => {
  it("writes a content-addressed object once and reuses its catalog record", async () => {
    const records = new Map();
    const repository: ImmutableObjectRepository = {
      find: vi.fn(async ({ checksumSha256, formatVersion }) =>
        records.get(`${checksumSha256}:${formatVersion}`) ?? null),
      register: vi.fn(async (record) => {
        const stored = {
          ...record,
          createdAt: record.verifiedAt,
          verifiedAt: record.verifiedAt
        };
        records.set(`${record.checksumSha256}:${record.formatVersion}`, stored);
        return stored;
      })
    };
    const putObject = vi.fn(async () => undefined);
    const writer = createImmutableObjectWriter({
      repository,
      storage: { keyspace: createStorageKeyspace("test"), putObject },
      now: () => new Date("2026-07-17T00:00:00.000Z")
    });

    const first = await writer.write({ body: "# Stable", contentType: "text/markdown" });
    const second = await writer.write({ body: "# Stable", contentType: "text/markdown" });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.objectKey).toMatch(/^test\/generated\/v1\/objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/);
    expect(putObject).toHaveBeenCalledOnce();
  });
});
