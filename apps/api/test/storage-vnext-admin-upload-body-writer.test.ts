import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { writeStorageVnextUploadBody } from
  "../src/storage-vnext/api/admin-upload-body-writer.js";

describe("storage vNext admin upload body writer", () => {
  it("accepts provider-normalized content types and purges every temporary-object version", async () => {
    const body = Buffer.from("# Temporary upload\n", "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const storageKey = `runs/upload/source-objects/${checksum}.md`;
    let temporaryKey = "";
    let temporaryVersionPurged = false;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        temporaryKey = String(command.input.Key);
        for await (const _chunk of command.input.Body as AsyncIterable<Uint8Array>) {
          // Consume the request stream like the provider does.
        }
        return { VersionId: "temporary-version" };
      }
      if (command instanceof CopyObjectCommand) return {};
      if (command instanceof HeadObjectCommand) {
        if (command.input.Key === storageKey) {
          return {
            ContentLength: body.byteLength,
            ContentType: "text/markdown;charset=utf-8",
            Metadata: {
              "checksum-sha256": checksum,
              "object-format": "source-markdown-v1"
            }
          };
        }
        throw missingObject();
      }
      if (command instanceof ListObjectVersionsCommand) {
        return temporaryVersionPurged
          ? { Versions: [], DeleteMarkers: [], IsTruncated: false }
          : {
              Versions: [{ Key: temporaryKey, VersionId: "temporary-version" }],
              DeleteMarkers: [],
              IsTruncated: false
            };
      }
      if (command instanceof ListMultipartUploadsCommand) {
        return { Uploads: [], IsTruncated: false };
      }
      if (command instanceof DeleteObjectsCommand) {
        temporaryVersionPurged = true;
        return { Deleted: command.input.Delete?.Objects };
      }
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error("Unexpected S3 command");
    });
    const registrations = {
      reserve: vi.fn(async (reservation) => ({
        outcome: "reserved" as const,
        registration: {
          ...reservation,
          state: "reserved" as const,
          verifiedAt: null,
          zeroOwnerSince: null
        }
      })),
      markVerified: vi.fn(async (verified) => ({
        objectId: verified.objectId,
        storageKey,
        checksum,
        byteCount: body.byteLength,
        contentType: "text/markdown; charset=utf-8",
        format: "source-markdown-v1",
        state: "verified" as const,
        writeAttemptPublicId: verified.writeAttemptPublicId,
        verifiedAt: verified.verifiedAt,
        zeroOwnerSince: verified.verifiedAt,
        createdAt: verified.verifiedAt
      }))
    };

    await expect(writeStorageVnextUploadBody({
      s3: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/upload",
      registrations: registrations as never,
      compensation: { compensate: vi.fn() },
      describeSource: () => ({
        objectId: `source-sha256:${checksum}`,
        storageKey,
        checksum,
        byteCount: body.byteLength,
        contentType: "text/markdown; charset=utf-8",
        objectFormat: "source-markdown-v1"
      }),
      request: {
        knowledgeBaseId: "kb-upload",
        sessionId: "session-upload",
        entryId: "entry-upload",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          }
        })
      },
      entry: {
        upload_session_public_id: "session-upload",
        entry_public_id: "entry-upload",
        source_file_public_id: "source-upload",
        logical_path: "temporary.md",
        normalized_path: "temporary.md",
        checksum_sha256: checksum,
        byte_count: body.byteLength,
        object_id: null,
        state: "pending",
        existing_resource_revision: null
      }
    })).resolves.toMatchObject({ storageKey, checksum });

    expect(temporaryVersionPurged).toBe(true);
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand))
      .toBe(false);
  });

  it("restores a missing verified source object from the current upload body", async () => {
    const body = Buffer.from("# Restored upload\n", "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const storageKey = `runs/upload/source-objects/${checksum}.md`;
    let temporaryKey = "";
    let targetHeadCount = 0;
    let temporaryVersionPurged = false;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        temporaryKey = String(command.input.Key);
        for await (const _chunk of command.input.Body as AsyncIterable<Uint8Array>) {
          // Consume the request stream like the provider does.
        }
        return { VersionId: "temporary-version" };
      }
      if (command instanceof CopyObjectCommand) return {};
      if (command instanceof HeadObjectCommand && command.input.Key === storageKey) {
        targetHeadCount += 1;
        if (targetHeadCount === 1) throw missingObject();
        return {
          ContentLength: body.byteLength,
          ContentType: "text/markdown; charset=utf-8",
          Metadata: {
            "checksum-sha256": checksum,
            "object-format": "source-markdown-v1"
          }
        };
      }
      if (command instanceof HeadObjectCommand) throw missingObject();
      if (command instanceof ListObjectVersionsCommand) {
        return temporaryVersionPurged
          ? { Versions: [], DeleteMarkers: [], IsTruncated: false }
          : {
              Versions: [{ Key: temporaryKey, VersionId: "temporary-version" }],
              DeleteMarkers: [],
              IsTruncated: false
            };
      }
      if (command instanceof ListMultipartUploadsCommand) {
        return { Uploads: [], IsTruncated: false };
      }
      if (command instanceof DeleteObjectsCommand) {
        temporaryVersionPurged = true;
        return { Deleted: command.input.Delete?.Objects };
      }
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error("Unexpected S3 command");
    });
    const markVerified = vi.fn();
    const verifiedAt = "2026-08-10T00:00:00.000Z";

    await expect(writeStorageVnextUploadBody({
      s3: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/upload",
      registrations: {
        reserve: vi.fn(async (reservation) => ({
          outcome: "reused" as const,
          registration: {
            ...reservation,
            state: "verified" as const,
            verifiedAt,
            zeroOwnerSince: null
          }
        })),
        markVerified
      } as never,
      compensation: { compensate: vi.fn() },
      describeSource: () => ({
        objectId: `source-sha256:${checksum}`,
        storageKey,
        checksum,
        byteCount: body.byteLength,
        contentType: "text/markdown; charset=utf-8",
        objectFormat: "source-markdown-v1"
      }),
      request: {
        knowledgeBaseId: "kb-upload",
        sessionId: "session-upload",
        entryId: "entry-upload",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          }
        })
      },
      entry: {
        upload_session_public_id: "session-upload",
        entry_public_id: "entry-upload",
        source_file_public_id: "source-upload",
        logical_path: "restored.md",
        normalized_path: "restored.md",
        checksum_sha256: checksum,
        byte_count: body.byteLength,
        object_id: null,
        state: "pending",
        existing_resource_revision: null
      }
    })).resolves.toMatchObject({ storageKey, checksum });

    expect(send.mock.calls.filter(([command]) => command instanceof CopyObjectCommand))
      .toHaveLength(1);
    expect(markVerified).not.toHaveBeenCalled();
    expect(temporaryVersionPurged).toBe(true);
  });
});

function missingObject(): Error {
  return Object.assign(new Error("missing"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 }
  });
}
