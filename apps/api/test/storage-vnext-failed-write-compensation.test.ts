import { describe, expect, it, vi } from "vitest";
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand
} from "@aws-sdk/client-s3";
import {
  createStorageVnextFailedWriteCompensator,
  createS3StorageVnextFailedWriteProvider,
  recoverStorageVnextStaleReservations
} from "../src/storage-vnext/ownership/failed-write-compensation.js";
import {
  createStorageVnextImmutableObjectWriter
} from "../src/storage-vnext/ownership/immutable-object-writer.js";
import type {
  StorageVnextObjectRegistration,
  StorageVnextOwnershipRepository
} from "../src/storage-vnext/ownership/ports.js";

const descriptor = {
  objectId: `source-sha256:${"a".repeat(64)}`,
  storageKey: `runs/svnext-compensation/source-objects/sha256/aa/${"a".repeat(64)}.md`,
  checksum: "a".repeat(64),
  byteCount: 4,
  contentType: "text/markdown; charset=utf-8",
  objectFormat: "source-markdown-v1" as const
};

describe("storage vNext failed immutable-write compensation", () => {
  it.each([
    ["upload_failed", Object.assign(new Error("refused"), { code: "provider_error" })],
    ["metadata_mismatch", Object.assign(new Error("mismatch"), {
      code: "object_verification_failed"
    })],
    ["timed_out", Object.assign(new Error("timeout"), { name: "TimeoutError" })]
  ] as const)("compensates %s after reservation", async (reasonCode, failure) => {
    const registrations = registrationRepository({ state: "reserved" });
    const compensation = { compensate: vi.fn(async () => "deleted" as const) };
    const writer = createStorageVnextImmutableObjectWriter({
      registrations,
      bodyStore: {
        describe: () => descriptor,
        putVerified: vi.fn(async () => { throw failure; }),
        verify: vi.fn(async () => undefined),
        readVerified: vi.fn()
      },
      compensation,
      clock: () => "2026-08-01T03:00:00.000Z"
    });

    await expect(writer.putVerified({
      bytes: new TextEncoder().encode("body"),
      objectFormat: "source-markdown-v1",
      writeAttemptPublicId: "write-failure",
      createdAt: "2026-08-01T02:59:00.000Z"
    })).rejects.toBe(failure);
    expect(compensation.compensate).toHaveBeenCalledWith({
      objectId: descriptor.objectId,
      storageKey: descriptor.storageKey,
      writeAttemptPublicId: "write-failure",
      reasonCode,
      failedAt: "2026-08-01T03:00:00.000Z"
    });
  });

  it("compensates a database failure after provider verification", async () => {
    const registrations = registrationRepository({
      state: "reserved",
      markVerifiedError: new Error("database unavailable")
    });
    const compensation = { compensate: vi.fn(async () => "deleted" as const) };
    const writer = createStorageVnextImmutableObjectWriter({
      registrations,
      bodyStore: {
        describe: () => descriptor,
        putVerified: vi.fn(async () => ({ ...descriptor, outcome: "stored" as const })),
        verify: vi.fn(async () => undefined),
        readVerified: vi.fn()
      },
      compensation,
      clock: () => "2026-08-01T03:00:00.000Z"
    });

    await expect(writer.putVerified({
      bytes: new TextEncoder().encode("body"),
      objectFormat: "source-markdown-v1",
      writeAttemptPublicId: "write-database",
      createdAt: "2026-08-01T02:59:00.000Z"
    })).rejects.toThrow("database unavailable");
    expect(compensation.compensate).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "registration_failed"
    }));
  });

  it("does not compensate a duplicate writer that never owned the reservation", async () => {
    const registrations = registrationRepository({
      state: "reserved",
      reserveError: Object.assign(new Error("busy"), { code: "write_in_progress" })
    });
    const putVerified = vi.fn();
    const compensation = { compensate: vi.fn() };
    const writer = createStorageVnextImmutableObjectWriter({
      registrations,
      bodyStore: {
        describe: () => descriptor,
        putVerified,
        verify: vi.fn(),
        readVerified: vi.fn()
      },
      compensation,
      clock: () => "2026-08-01T03:00:00.000Z"
    });

    await expect(writer.putVerified({
      bytes: new TextEncoder().encode("body"),
      objectFormat: "source-markdown-v1",
      writeAttemptPublicId: "write-duplicate",
      createdAt: "2026-08-01T02:59:00.000Z"
    })).rejects.toMatchObject({ code: "write_in_progress" });
    expect(putVerified).not.toHaveBeenCalled();
    expect(compensation.compensate).not.toHaveBeenCalled();
  });

  it("aborts multipart state, deletes provider bytes, and closes reserved or verified rows", async () => {
    const registrations = registrationRepository({ state: "reserved" });
    const abortMultipartUploads = vi.fn(async () => undefined);
    const deleteCurrentObject = vi.fn(async () => undefined);
    const compensator = createStorageVnextFailedWriteCompensator({
      registrations,
      provider: { abortMultipartUploads, deleteCurrentObject }
    });

    await expect(compensator.compensate({
      objectId: descriptor.objectId,
      storageKey: descriptor.storageKey,
      writeAttemptPublicId: "write-failure",
      reasonCode: "process_terminated",
      failedAt: "2026-08-01T03:00:00.000Z"
    })).resolves.toBe("deleted");
    expect(abortMultipartUploads).toHaveBeenCalledWith(descriptor.storageKey);
    expect(deleteCurrentObject).toHaveBeenCalledWith(descriptor.storageKey);
    expect(registrations.deleteFailedReservation).toHaveBeenCalledWith({
      objectId: descriptor.objectId,
      writeAttemptPublicId: "write-failure"
    });
  });

  it("deletes a verified zero-owner object after a database owner-attach failure", async () => {
    const registrations = registrationRepository({ state: "verified" });
    const compensator = createStorageVnextFailedWriteCompensator({
      registrations,
      provider: {
        abortMultipartUploads: vi.fn(async () => undefined),
        deleteCurrentObject: vi.fn(async () => undefined)
      }
    });

    await expect(compensator.compensate({
      objectId: descriptor.objectId,
      storageKey: descriptor.storageKey,
      writeAttemptPublicId: "write-failure",
      reasonCode: "owner_attach_failed",
      failedAt: "2026-08-01T03:00:00.000Z"
    })).resolves.toBe("deleted");
    expect(registrations.markDeleting).toHaveBeenCalledWith(descriptor.objectId);
    expect(registrations.markDeleted).toHaveBeenCalledWith(descriptor.objectId);
    expect(registrations.deleteFailedReservation).not.toHaveBeenCalled();
  });

  it("recovers stale process-owned attempts through bounded pages", async () => {
    const registrations = registrationRepository({ state: "reserved" });
    const compensate = vi.fn(async () => "deleted" as const);
    const result = await recoverStorageVnextStaleReservations({
      registrations,
      compensation: { compensate },
      staleBefore: "2026-08-01T02:00:00.000Z",
      failedAt: "2026-08-01T03:00:00.000Z",
      limit: 10,
      cursor: null
    });

    expect(result).toEqual({ processed: 1, nextCursor: null });
    expect(compensate).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "process_terminated"
    }));
  });

  it("aborts every exact-key multipart upload and deletes only the owned current key", async () => {
    const send = vi.fn(async (command:
      | ListMultipartUploadsCommand
      | AbortMultipartUploadCommand
      | DeleteObjectCommand) => {
      if (command instanceof ListMultipartUploadsCommand) {
        return {
          Uploads: [
            { Key: descriptor.storageKey, UploadId: "upload-a" },
            { Key: `${descriptor.storageKey}.other`, UploadId: "upload-other" },
            { Key: descriptor.storageKey, UploadId: "upload-b" }
          ],
          IsTruncated: false
        };
      }
      return {};
    });
    const provider = createS3StorageVnextFailedWriteProvider({
      client: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-compensation"
    });

    await provider.abortMultipartUploads(descriptor.storageKey);
    await provider.deleteCurrentObject(descriptor.storageKey);

    const aborted = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof AbortMultipartUploadCommand)
      .map((command) => command.input.UploadId);
    expect(aborted).toEqual(["upload-a", "upload-b"]);
    expect(send.mock.calls.map(([command]) => command).find(
      (command) => command instanceof DeleteObjectCommand
    )?.input).toEqual({ Bucket: "owned-bucket", Key: descriptor.storageKey });
    await expect(provider.deleteCurrentObject("other/prefix.md"))
      .rejects.toMatchObject({ code: "scope_conflict" });
  });
});

function registrationRepository(input: {
  state: "reserved" | "verified";
  reserveError?: Error;
  markVerifiedError?: Error;
}): StorageVnextOwnershipRepository & {
  deleteFailedReservation: ReturnType<typeof vi.fn>;
  markDeleting: ReturnType<typeof vi.fn>;
  markDeleted: ReturnType<typeof vi.fn>;
} {
  let registration: StorageVnextObjectRegistration | null = {
    objectId: descriptor.objectId,
    storageKey: descriptor.storageKey,
    checksum: descriptor.checksum,
    byteCount: descriptor.byteCount,
    contentType: descriptor.contentType,
    format: descriptor.objectFormat,
    state: input.state,
    writeAttemptPublicId: "write-failure",
    verifiedAt: input.state === "verified" ? "2026-08-01T02:59:30.000Z" : null,
    zeroOwnerSince: input.state === "verified" ? "2026-08-01T02:59:30.000Z" : null,
    createdAt: "2026-08-01T02:59:00.000Z"
  };
  const deleteFailedReservation = vi.fn(async () => {
    registration = null;
  });
  const markDeleting = vi.fn(async () => undefined);
  const markDeleted = vi.fn(async () => undefined);
  return {
    async reserve(reservation) {
      if (input.reserveError) throw input.reserveError;
      registration = {
        ...registration!,
        writeAttemptPublicId: reservation.writeAttemptPublicId
      };
      return { outcome: "reserved", registration: registration! };
    },
    async markVerified() {
      if (input.markVerifiedError) throw input.markVerifiedError;
      registration = { ...registration!, state: "verified" };
      return registration;
    },
    async getRegistration() { return registration; },
    async getRegistrationsByStorageKeys() { return registration ? [registration] : []; },
    async listRegistrations() {
      return { items: registration ? [registration] : [], nextCursor: null };
    },
    async getClosure() {
      return {
        objectId: descriptor.objectId,
        owners: [],
        ownerCount: 0,
        referenceCount: 0,
        graceExpiresAt: null
      };
    },
    async listZeroOwnerObjects() { return { items: [], nextCursor: null }; },
    async listStaleReservations() {
      return { items: registration ? [registration] : [], nextCursor: null };
    },
    async attach() {},
    async release() {},
    markDeleting,
    markDeleted,
    deleteFailedReservation
  };
}
