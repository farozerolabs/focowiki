import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createS3StorageVnextImmutableBodyStore
} from "../src/storage-vnext/ownership/s3-immutable-body-store.js";
import {
  createStorageVnextImmutableObjectWriter
} from "../src/storage-vnext/ownership/immutable-object-writer.js";
import type {
  StorageVnextObjectRegistration,
  StorageVnextOwnershipRepository
} from "../src/storage-vnext/ownership/ports.js";

describe("storage vNext immutable object writer", () => {
  it("reserves before PUT and verifies one content-addressed source registration", async () => {
    const bytes = new TextEncoder().encode("# Source\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const events: string[] = [];
    let registration: StorageVnextObjectRegistration | null = null;
    const registrations = registrationFixture({ events, get: () => registration, set: (value) => {
      registration = value;
    } });
    const send = vi.fn(async (_command: HeadObjectCommand | PutObjectCommand) => {
      events.push("put");
      return {};
    });
    const writer = createStorageVnextImmutableObjectWriter({
      registrations,
      compensation: { compensate: vi.fn(async () => "deleted" as const) },
      clock: () => "2026-08-01T00:00:30.000Z",
      bodyStore: createS3StorageVnextImmutableBodyStore({
        client: { send } as never,
        bucket: "owned-bucket",
        prefix: "runs/svnext-object01"
      })
    });

    const result = await writer.putVerified({
      bytes,
      objectFormat: "source-markdown-v1",
      writeAttemptPublicId: "write-source-1",
      createdAt: "2026-08-01T00:00:00.000Z"
    });

    expect(result).toMatchObject({
      outcome: "stored",
      objectId: `source-sha256:${checksum}`,
      storageKey: `runs/svnext-object01/source-objects/sha256/${checksum.slice(0, 2)}/${checksum}.md`,
      checksum,
      objectFormat: "source-markdown-v1",
      requests: { put: 1, head: 0, verification: 0 }
    });
    expect(events).toEqual(["reserve", "put", "verify"]);
    const put = send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.ContentLength).toBe(bytes.byteLength);
    expect(put.input.Body).toBeInstanceOf(Readable);
    expect(put.input.IfNoneMatch).toBeUndefined();
    const uploaded: Buffer[] = [];
    for await (const chunk of put.input.Body as Readable) uploaded.push(Buffer.from(chunk));
    expect(Buffer.concat(uploaded)).toEqual(Buffer.from(bytes));
    expect(registration).toMatchObject({
      objectId: result.objectId,
      state: "verified",
      writeAttemptPublicId: "write-source-1"
    });
  });

  it("uses format-qualified generated keys and reuses verified bytes without another PUT", async () => {
    const bytes = new TextEncoder().encode("# Generated\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    let registration: StorageVnextObjectRegistration | null = null;
    const registrations = registrationFixture({ get: () => registration, set: (value) => {
      registration = value;
    } });
    const send = vi.fn(async (command: HeadObjectCommand | PutObjectCommand) => {
      if (command instanceof HeadObjectCommand) {
        throw new Error("Verified reuse must not read remote metadata");
      }
      return {};
    });
    const writer = createStorageVnextImmutableObjectWriter({
      registrations,
      compensation: { compensate: vi.fn(async () => "deleted" as const) },
      clock: () => "2026-08-01T00:00:30.000Z",
      bodyStore: createS3StorageVnextImmutableBodyStore({
        client: { send } as never,
        bucket: "owned-bucket",
        prefix: "runs/svnext-object01"
      })
    });

    const first = await writer.putVerified({
      bytes,
      objectFormat: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-generated-1",
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    const second = await writer.putVerified({
      bytes,
      objectFormat: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-generated-2",
      createdAt: "2026-08-01T00:01:00.000Z"
    });

    expect(first.objectId).toBe(`generated-sha256:okf-generated-markdown-v1:${checksum}`);
    expect(first.storageKey).toBe(
      `runs/svnext-object01/generated-objects/okf-generated-markdown-v1/sha256/${checksum.slice(0, 2)}/${checksum}.md`
    );
    expect(second).toMatchObject({
      outcome: "reused",
      objectId: first.objectId,
      requests: { put: 0, head: 0, verification: 0, attemptedBytes: 0 }
    });
    expect(send.mock.calls.filter(([command]) => command instanceof PutObjectCommand))
      .toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();
  });

  it("waits for an identical object cleanup before reserving the deleted registration", async () => {
    const bytes = new TextEncoder().encode("# Recreated after cleanup\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const objectId = `generated-sha256:okf-generated-markdown-v1:${checksum}`;
    const storageKey =
      `runs/svnext-object01/generated-objects/okf-generated-markdown-v1/sha256/${checksum.slice(0, 2)}/${checksum}.md`;
    let registration: StorageVnextObjectRegistration = {
      objectId,
      storageKey,
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      state: "deleting",
      writeAttemptPublicId: "write-generated-cleanup",
      createdAt: "2026-08-01T00:00:00.000Z",
      verifiedAt: "2026-08-01T00:00:01.000Z",
      zeroOwnerSince: "2026-08-01T00:00:02.000Z"
    };
    let reserveCount = 0;
    let registrationReadCount = 0;
    const baseRegistrations = registrationFixture({
      get: () => registration,
      set: (value) => {
        registration = value;
      }
    });
    const registrations: StorageVnextOwnershipRepository = {
      ...baseRegistrations,
      async reserve(reservation) {
        reserveCount += 1;
        if (reserveCount === 1) {
          throw Object.assign(new Error("cleanup in progress"), { code: "state_conflict" });
        }
        registration = {
          ...reservation,
          state: "reserved",
          verifiedAt: null,
          zeroOwnerSince: null
        };
        return { outcome: "reserved", registration };
      },
      async getRegistration() {
        registrationReadCount += 1;
        if (registrationReadCount === 1) {
          const deleting = registration;
          registration = { ...registration, state: "deleted" };
          return deleting;
        }
        return registration;
      }
    };
    const send = vi.fn(async (_command: PutObjectCommand) => ({}));
    const writer = createStorageVnextImmutableObjectWriter({
      registrations,
      compensation: { compensate: vi.fn(async () => "deleted" as const) },
      clock: () => "2026-08-01T00:00:30.000Z",
      concurrentWriteWaitMilliseconds: 1_000,
      concurrentWritePollMilliseconds: 0,
      bodyStore: createS3StorageVnextImmutableBodyStore({
        client: { send } as never,
        bucket: "owned-bucket",
        prefix: "runs/svnext-object01"
      })
    });

    await expect(writer.putVerified({
      bytes,
      objectFormat: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-generated-recreated",
      createdAt: "2026-08-01T00:00:30.000Z"
    })).resolves.toMatchObject({ outcome: "stored", objectId });
    expect(reserveCount).toBe(2);
    expect(registrationReadCount).toBeGreaterThanOrEqual(2);
    expect(registration).toMatchObject({
      state: "verified",
      writeAttemptPublicId: "write-generated-recreated"
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("routes verified registrations to background repair without a remote request", async () => {
    const bytes = new TextEncoder().encode("# Restored generated Markdown\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const objectId = `generated-sha256:okf-generated-markdown-v1:${checksum}`;
    const registration: StorageVnextObjectRegistration = {
      objectId,
      storageKey:
        `runs/svnext-object01/generated-objects/okf-generated-markdown-v1/sha256/${checksum.slice(0, 2)}/${checksum}.md`,
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      format: "okf-generated-markdown-v1",
      state: "verified",
      writeAttemptPublicId: "write-generated-original",
      createdAt: "2026-08-01T00:00:00.000Z",
      verifiedAt: "2026-08-01T00:00:01.000Z",
      zeroOwnerSince: null
    };
    const registrations = registrationFixture({
      get: () => registration,
      set: () => undefined
    });
    const send = vi.fn(async () => {
      throw new Error("Verified reuse must not call the provider");
    });
    const writer = createStorageVnextImmutableObjectWriter({
      registrations,
      compensation: { compensate: vi.fn(async () => "deleted" as const) },
      clock: () => "2026-08-01T00:00:30.000Z",
      bodyStore: createS3StorageVnextImmutableBodyStore({
        client: { send } as never,
        bucket: "owned-bucket",
        prefix: "runs/svnext-object01"
      })
    });

    await expect(writer.putVerified({
      bytes,
      objectFormat: "okf-generated-markdown-v1",
      writeAttemptPublicId: "write-generated-repair",
      createdAt: "2026-08-01T00:02:00.000Z"
    })).resolves.toMatchObject({ outcome: "reused", objectId });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not verify a registration when the provider write fails", async () => {
    const bytes = new TextEncoder().encode("mismatch");
    let registration: StorageVnextObjectRegistration | null = null;
    const registrations = registrationFixture({ get: () => registration, set: (value) => {
      registration = value;
    } });
    const send = vi.fn(async () => {
      throw new Error("provider write failed");
    });
    const writer = createStorageVnextImmutableObjectWriter({
      registrations,
      compensation: { compensate: vi.fn(async () => "deleted" as const) },
      clock: () => "2026-08-01T00:00:30.000Z",
      bodyStore: createS3StorageVnextImmutableBodyStore({
        client: { send } as never,
        bucket: "owned-bucket",
        prefix: "runs/svnext-object01"
      })
    });

    await expect(writer.putVerified({
      bytes,
      objectFormat: "source-markdown-v1",
      writeAttemptPublicId: "write-mismatch-1",
      createdAt: "2026-08-01T00:00:00.000Z"
    })).rejects.toThrow("provider write failed");
    expect(registration).toMatchObject({ state: "reserved" });
  });

  it("uses an unconditional content-addressed write for S3-compatible providers", async () => {
    const bytes = new TextEncoder().encode("existing body");
    const send = vi.fn(async (_command: PutObjectCommand) => ({}));
    const store = createS3StorageVnextImmutableBodyStore({
      client: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-object01"
    });
    const descriptor = store.describe({ bytes, objectFormat: "source-markdown-v1" });

    await expect(store.putVerified({ descriptor, bytes })).resolves.toMatchObject({
      outcome: "stored",
      requests: {
        put: 1,
        head: 0,
        verification: 0,
        attemptedBytes: bytes.byteLength,
        retries: 0
      }
    });
    expect(send.mock.calls.filter(([command]) => command instanceof PutObjectCommand))
      .toHaveLength(1);
    const put = send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(put.input.IfNoneMatch).toBeUndefined();
  });

  it("reads generated bytes only after metadata, size, and checksum verification", async () => {
    const bytes = new TextEncoder().encode("# Verified generated Markdown\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const store = createS3StorageVnextImmutableBodyStore({
      client: {
        send: vi.fn(async (command: HeadObjectCommand | GetObjectCommand) => {
          if (command instanceof HeadObjectCommand) {
            return verifiedMetadata(
              checksum,
              bytes.byteLength,
              "okf-generated-markdown-v1"
            );
          }
          return { Body: { transformToByteArray: async () => bytes } };
        })
      } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-object01"
    });
    const descriptor = store.describe({
      bytes,
      objectFormat: "okf-generated-markdown-v1"
    });
    const jsonDescriptor = store.describe({
      bytes: new TextEncoder().encode("{}\n"),
      objectFormat: "okf-generated-json-v1"
    });

    expect(jsonDescriptor.contentType).toBe("application/json; charset=utf-8");
    await expect(store.readVerified({
      descriptor,
      maximumBytes: bytes.byteLength
    })).resolves.toEqual(bytes);
    await expect(store.readVerified({
      descriptor,
      maximumBytes: bytes.byteLength - 1
    })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

function registrationFixture(input: {
  events?: string[];
  get: () => StorageVnextObjectRegistration | null;
  set: (value: StorageVnextObjectRegistration) => void;
}): StorageVnextOwnershipRepository {
  return {
    async reserve(reservation) {
      input.events?.push("reserve");
      const current = input.get();
      if (current) return { outcome: "reused", registration: current };
      const created: StorageVnextObjectRegistration = {
        ...reservation,
        state: "reserved",
        verifiedAt: null,
        zeroOwnerSince: null
      };
      input.set(created);
      return { outcome: "reserved", registration: created };
    },
    async markVerified(verification) {
      input.events?.push("verify");
      const current = input.get();
      if (!current) throw new Error("Missing registration fixture");
      const verified: StorageVnextObjectRegistration = {
        ...current,
        state: "verified",
        verifiedAt: verification.verifiedAt,
        zeroOwnerSince: verification.verifiedAt
      };
      input.set(verified);
      return verified;
    },
    async getRegistration() {
      return input.get();
    },
    async getRegistrationsByStorageKeys() {
      return input.get() ? [input.get()!] : [];
    },
    async listRegistrations() {
      return { items: input.get() ? [input.get()!] : [], nextCursor: null };
    },
    async getClosure() {
      throw new Error("Unexpected owner read");
    },
    async listZeroOwnerObjects() {
      throw new Error("Unexpected zero-owner read");
    },
    async listStaleReservations() {
      throw new Error("Unexpected stale-reservation read");
    },
    async attach() {
      throw new Error("Unexpected owner attach");
    },
    async release() {
      throw new Error("Unexpected owner release");
    },
    async releaseVerifiedReservation() {
      throw new Error("Unexpected verified reservation release");
    },
    async markDeleting() {
      throw new Error("Unexpected deleting transition");
    },
    async markDeleted() {
      throw new Error("Unexpected deleted transition");
    },
    async deleteFailedReservation() {
      throw new Error("Unexpected failed-reservation deletion");
    }
  };
}

function verifiedMetadata(checksum: string, byteCount: number, objectFormat: string) {
  return {
    ContentLength: byteCount,
    ContentType: "text/markdown;charset=utf-8",
    Metadata: {
      "checksum-sha256": checksum,
      "object-format": objectFormat
    }
  };
}
