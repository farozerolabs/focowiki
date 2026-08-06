import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  StorageVnextObjectRegistration,
  StorageVnextOwnershipRepository
} from "../src/storage-vnext/ownership/ports.js";
import { createStorageVnextStreamingUploadBodyWriter } from
  "../src/storage-vnext/upload/streaming-body-writer.js";

describe("storage vNext streaming upload body writer", () => {
  it("reserves, streams, verifies, and marks one immutable registration", async () => {
    const body = Buffer.from("# Stream owner\n", "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const fixture = createFixture(checksum, body.byteLength);
    const writer = createStorageVnextStreamingUploadBodyWriter(fixture.ports);

    await expect(writer.putVerifiedStream({
      body: chunks(body),
      checksumSha256: checksum,
      byteCount: body.byteLength,
      contentType: "text/markdown; charset=utf-8",
      writeAttemptPublicId: "upload-write-stream-one"
    })).resolves.toEqual({
      outcome: "stored",
      objectId: `source-sha256:${checksum}`,
      checksumSha256: checksum,
      byteCount: body.byteLength,
      contentType: "text/markdown; charset=utf-8"
    });
    expect(fixture.events).toEqual(["reserve", "stream", "verify"]);
    expect(fixture.registration).toMatchObject({
      state: "verified",
      writeAttemptPublicId: "upload-write-stream-one"
    });
  });

  it("reuses one verified registration while still consuming the replay body", async () => {
    const body = Buffer.from("same streamed body", "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const fixture = createFixture(checksum, body.byteLength, "verified");
    const writer = createStorageVnextStreamingUploadBodyWriter(fixture.ports);
    let consumed = 0;

    await expect(writer.putVerifiedStream({
      body: (async function* () {
        consumed += body.byteLength;
        yield body;
      })(),
      checksumSha256: checksum,
      byteCount: body.byteLength,
      contentType: "text/markdown; charset=utf-8",
      writeAttemptPublicId: "upload-write-stream-replay"
    })).resolves.toMatchObject({ outcome: "reused" });
    expect(consumed).toBe(body.byteLength);
    expect(fixture.events).toEqual(["reserve", "stream"]);
  });

  it("compensates an owned timed-out reservation without marking it verified", async () => {
    const body = Buffer.from("timeout", "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const fixture = createFixture(checksum, body.byteLength);
    const timeout = new Error("Provider timeout");
    timeout.name = "TimeoutError";
    fixture.bodyStore.putVerifiedStream.mockRejectedValueOnce(timeout);
    const writer = createStorageVnextStreamingUploadBodyWriter(fixture.ports);

    await expect(writer.putVerifiedStream({
      body: chunks(body),
      checksumSha256: checksum,
      byteCount: body.byteLength,
      contentType: "text/markdown; charset=utf-8",
      writeAttemptPublicId: "upload-write-stream-timeout"
    })).rejects.toBe(timeout);
    expect(fixture.compensate).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "timed_out",
      writeAttemptPublicId: "upload-write-stream-timeout"
    }));
    expect(fixture.events).toEqual(["reserve"]);
  });
});

function createFixture(
  checksum: string,
  byteCount: number,
  initialState: "reserved" | "verified" | null = null
) {
  const events: string[] = [];
  let clockTick = 0;
  let registration: StorageVnextObjectRegistration | null = initialState ? {
    objectId: `source-sha256:${checksum}`,
    storageKey: `runs/svnext-upload/source-objects/sha256/${checksum.slice(0, 2)}/${checksum}.md`,
    checksum,
    byteCount,
    contentType: "text/markdown; charset=utf-8",
    format: "source-markdown-v1",
    state: initialState,
    writeAttemptPublicId: initialState === "verified"
      ? "upload-write-existing"
      : "upload-write-stream-one",
    verifiedAt: initialState === "verified" ? "2026-08-01T00:00:00.000Z" : null,
    zeroOwnerSince: initialState === "verified" ? "2026-08-01T00:00:00.000Z" : null,
    createdAt: "2026-08-01T00:00:00.000Z"
  } : null;
  const registrations = registrationPort({
    events,
    get: () => registration,
    set: (next) => {
      registration = next;
    }
  });
  const descriptor = {
    objectId: `source-sha256:${checksum}`,
    storageKey: `runs/svnext-upload/source-objects/sha256/${checksum.slice(0, 2)}/${checksum}.md`,
    checksum,
    byteCount,
    contentType: "text/markdown; charset=utf-8" as const,
    objectFormat: "source-markdown-v1" as const
  };
  const bodyStore = {
    describeExpected: vi.fn(() => descriptor),
    putVerifiedStream: vi.fn(async (input: { body: AsyncIterable<Uint8Array> }) => {
      events.push("stream");
      for await (const _chunk of input.body) {
        // Consume the bounded request stream.
      }
      return { ...descriptor, outcome: initialState === "verified" ? "reused" as const : "stored" as const };
    })
  };
  const compensate = vi.fn(async () => "deleted" as const);
  return {
    events,
    bodyStore,
    compensate,
    get registration() {
      return registration;
    },
    ports: {
      registrations,
      bodyStore,
      compensation: { compensate },
      clock: () => new Date(Date.UTC(2026, 7, 1, 0, 0, clockTick++)).toISOString()
    }
  };
}

function registrationPort(input: {
  events: string[];
  get: () => StorageVnextObjectRegistration | null;
  set: (registration: StorageVnextObjectRegistration) => void;
}): StorageVnextOwnershipRepository {
  return {
    async reserve(reservation) {
      input.events.push("reserve");
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
    async markVerified(verified) {
      input.events.push("verify");
      const current = input.get();
      if (!current) throw new Error("Missing upload registration fixture");
      const next: StorageVnextObjectRegistration = {
        ...current,
        state: "verified",
        verifiedAt: verified.verifiedAt,
        zeroOwnerSince: verified.verifiedAt
      };
      input.set(next);
      return next;
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
      throw new Error("Unexpected ownership closure read");
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
    async markDeleting() {
      throw new Error("Unexpected deleting transition");
    },
    async markDeleted() {
      throw new Error("Unexpected deleted transition");
    },
    async deleteFailedReservation() {
      throw new Error("Unexpected failed-reservation delete");
    }
  };
}

async function* chunks(body: Uint8Array): AsyncGenerator<Uint8Array> {
  yield body.slice(0, 3);
  yield body.slice(3);
}
