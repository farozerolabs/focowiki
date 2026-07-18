import { describe, expect, it, vi } from "vitest";
import type {
  ActiveImmutableObjectRecord,
  ImmutableObjectRecord,
  ImmutableObjectRepository
} from "../src/application/ports/immutable-object-repository.js";
import { createImmutableObjectWriter } from "../src/publication/immutable-object-writer.js";
import { createStorageKeyspace } from "../src/storage/keys.js";

describe("immutable object writer", () => {
  it("reserves, uploads, verifies, and activates before reuse", async () => {
    const calls: string[] = [];
    const repository = createMemoryRepository(calls);
    const putObject = vi.fn(async () => { calls.push("upload"); });
    const headObjectMetadata = vi.fn(async (key: string) => {
      calls.push("verify");
      const record = repository.record();
      return record ? storedMetadata(key, record) : null;
    });
    const writer = createImmutableObjectWriter({
      repository,
      storage: {
        keyspace: createStorageKeyspace("test"),
        putObject,
        headObjectMetadata
      },
      now: sequenceClock()
    });

    const first = await writer.write({ body: "# Stable", contentType: "text/markdown" });
    const second = await writer.write({ body: "# Stable", contentType: "text/markdown" });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.objectKey).toMatch(/^test\/generated\/v1\/objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/);
    expect(calls).toEqual(["reserve", "upload", "verify", "activate"]);
    expect(putObject).toHaveBeenCalledOnce();
  });

  it("keeps a durable writing reservation when upload fails", async () => {
    const calls: string[] = [];
    const repository = createMemoryRepository(calls);
    const writer = createImmutableObjectWriter({
      repository,
      storage: {
        keyspace: createStorageKeyspace("test"),
        putObject: vi.fn(async () => { throw new Error("storage unavailable"); }),
        headObjectMetadata: vi.fn()
      }
    });

    await expect(writer.write({ body: "# Interrupted", contentType: "text/markdown" }))
      .rejects.toThrow("storage unavailable");
    expect(repository.record()).toMatchObject({
      lifecycleState: "writing",
      writeAttemptCount: 1
    });
    expect(calls).toEqual(["reserve", "failure"]);
  });

  it("does not upload when the durable reservation fails", async () => {
    const calls: string[] = [];
    const putObject = vi.fn();
    const repository = createMemoryRepository(calls);
    repository.reserve = vi.fn(async () => {
      throw new Error("reservation unavailable");
    });
    const writer = createImmutableObjectWriter({
      repository,
      storage: {
        keyspace: createStorageKeyspace("test"),
        putObject,
        headObjectMetadata: vi.fn()
      }
    });

    await expect(writer.write({ body: "# Reserved", contentType: "text/markdown" }))
      .rejects.toThrow("reservation unavailable");
    expect(putObject).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("leaves the verified upload recoverable when catalog activation fails", async () => {
    const calls: string[] = [];
    const repository = createMemoryRepository(calls);
    repository.activate = vi.fn(async () => {
      calls.push("activate");
      throw new Error("catalog unavailable");
    });
    const writer = createImmutableObjectWriter({
      repository,
      storage: {
        keyspace: createStorageKeyspace("test"),
        putObject: vi.fn(async () => { calls.push("upload"); }),
        headObjectMetadata: vi.fn(async (key: string) => {
          calls.push("verify");
          return storedMetadata(key, repository.record()!);
        })
      }
    });

    await expect(writer.write({ body: "# Recoverable", contentType: "text/markdown" }))
      .rejects.toThrow("catalog unavailable");
    expect(repository.record()).toMatchObject({ lifecycleState: "writing" });
    expect(calls).toEqual(["reserve", "upload", "verify", "activate", "failure"]);
  });

  it("does not activate an object whose stored identity cannot be verified", async () => {
    const calls: string[] = [];
    const repository = createMemoryRepository(calls);
    const writer = createImmutableObjectWriter({
      repository,
      storage: {
        keyspace: createStorageKeyspace("test"),
        putObject: vi.fn(async () => undefined),
        headObjectMetadata: vi.fn(async (key: string) => ({
          key,
          contentType: "text/markdown",
          sizeBytes: 1,
          etag: null,
          lastModified: null,
          metadata: {}
        }))
      }
    });

    await expect(writer.write({ body: "# Unverified", contentType: "text/markdown" }))
      .rejects.toThrow("verification failed");
    expect(repository.record()?.lifecycleState).toBe("writing");
    expect(calls).toEqual(["reserve", "failure"]);
  });

  it("waits for a concurrent identical reservation to become active", async () => {
    let active: ActiveImmutableObjectRecord | null = null;
    let findCalls = 0;
    const repository: ImmutableObjectRepository = {
      find: vi.fn(async () => findCalls++ > 0 ? active : null),
      findAny: vi.fn(async () => null),
      reserve: vi.fn(async (input) => {
        active = {
          checksumSha256: input.checksumSha256,
          formatVersion: input.formatVersion,
          objectKey: input.objectKey,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          lifecycleState: "active",
          writeToken: null,
          writeStartedAt: null,
          writeAttemptCount: 1,
          createdAt: input.writeStartedAt,
          verifiedAt: input.writeStartedAt
        };
        return {
          status: "pending" as const,
          record: { ...active, lifecycleState: "writing" as const, verifiedAt: null }
        };
      }),
      activate: vi.fn(async () => active!),
      markWriteFailure: vi.fn(async () => undefined)
    };
    const writer = createImmutableObjectWriter({
      repository,
      storage: {
        keyspace: createStorageKeyspace("test"),
        putObject: vi.fn(async () => undefined),
        headObjectMetadata: vi.fn(async () => null)
      },
      sleep: async () => undefined,
      pendingWaitMs: 20
    });

    await expect(writer.write({ body: "# Stable", contentType: "text/markdown" }))
      .resolves.toMatchObject({ reused: true, lifecycleState: "active" });
  });

  it("rejects a conflicting catalog identity without uploading", async () => {
    const putObject = vi.fn();
    const repository = createMemoryRepository([]);
    const expected = await createImmutableObjectWriter({
      repository,
      storage: {
        keyspace: createStorageKeyspace("test"),
        putObject: vi.fn(),
        headObjectMetadata: vi.fn()
      }
    }).write({ body: "# Conflict", contentType: "text/markdown" }).catch(() => null);
    expect(expected).toBeNull();

    const active = repository.record()!;
    repository.find = vi.fn(async () => ({
      ...active,
      lifecycleState: "active" as const,
      objectKey: `${active.objectKey}-conflict`,
      writeToken: null,
      writeStartedAt: null,
      verifiedAt: "2026-07-17T00:00:00.000Z"
    }));
    const writer = createImmutableObjectWriter({
      repository,
      storage: {
        keyspace: createStorageKeyspace("test"),
        putObject,
        headObjectMetadata: vi.fn()
      }
    });

    await expect(writer.write({ body: "# Conflict", contentType: "text/markdown" }))
      .rejects.toThrow("identity conflicts");
    expect(putObject).not.toHaveBeenCalled();
  });
});

function createMemoryRepository(calls: string[]): ImmutableObjectRepository & {
  record: () => ImmutableObjectRecord | null;
} {
  let record: ImmutableObjectRecord | null = null;
  return {
    record: () => record,
    async find() {
      return record?.lifecycleState === "active" ? record as ActiveImmutableObjectRecord : null;
    },
    async findAny() {
      return record;
    },
    async reserve(input) {
      calls.push("reserve");
      if (record?.lifecycleState === "active") return { status: "active", record };
      record = {
        ...input,
        lifecycleState: "writing",
        writeToken: input.writeToken,
        writeStartedAt: input.writeStartedAt,
        writeAttemptCount: (record?.writeAttemptCount ?? 0) + 1,
        createdAt: input.writeStartedAt,
        verifiedAt: null
      };
      return { status: "reserved", record };
    },
    async activate(input) {
      calls.push("activate");
      if (!record || record.writeToken !== input.writeToken) throw new Error("reservation lost");
      record = {
        ...record,
        lifecycleState: "active",
        writeToken: null,
        writeStartedAt: null,
        verifiedAt: input.verifiedAt
      };
      return record as ActiveImmutableObjectRecord;
    },
    async markWriteFailure() {
      calls.push("failure");
    }
  };
}

function sequenceClock(): () => Date {
  let second = 0;
  return () => new Date(`2026-07-17T00:00:0${Math.min(second++, 9)}.000Z`);
}

function storedMetadata(key: string, record: ImmutableObjectRecord) {
  return {
    key,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    etag: null,
    lastModified: null,
    metadata: {
      "focowiki-checksum-sha256": record.checksumSha256,
      "focowiki-format-version": String(record.formatVersion)
    }
  };
}
