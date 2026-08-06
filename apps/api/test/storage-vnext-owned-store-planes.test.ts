import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStorageVnextCoordinationPlane } from "../src/storage-vnext/bootstrap/coordination-plane.js";
import { createStorageVnextObjectPlane } from "../src/storage-vnext/bootstrap/object-plane.js";
import {
  createStorageVnextOwnerMarkerDocument,
  serializeStorageVnextOwnerMarker
} from "../src/storage-vnext/bootstrap/owner-marker.js";
import { createStorageVnextOwnedScopeProof } from "../src/storage-vnext/bootstrap/owned-scope.js";
import {
  createStorageVnextSearchPlane,
  type StorageVnextOwnedSearchClient
} from "../src/storage-vnext/bootstrap/search-plane.js";
import { synchronizeStorageVnextSearchReceipt } from "../src/storage-vnext/bootstrap/search-receipt.js";

const runId = "svnext-20260801T174500Z-c1d2e3f4a5b6";
const proof = createStorageVnextOwnedScopeProof({
  runId,
  nonceHash: "e".repeat(64),
  createdAt: "2026-08-01T09:45:00.000Z",
  filesystemScope: join(tmpdir(), runId)
});

describe("storage vNext owned concrete store planes", () => {
  it("deletes only exact S3 versions and multipart uploads while preserving the owner marker", async () => {
    const markerKey = `${proof.objectScope}_run-owner.json`;
    const state = {
      versions: [
        { Key: markerKey, VersionId: "marker-current", IsLatest: true },
        { Key: markerKey, VersionId: "marker-old", IsLatest: false },
        { Key: `${proof.objectScope}source/body.md`, VersionId: "body-current", IsLatest: true }
      ],
      deleteMarkers: [
        { Key: `${proof.objectScope}old.md`, VersionId: "deleted-old", IsLatest: true }
      ],
      uploads: [
        { Key: `${proof.objectScope}partial.bin`, UploadId: "upload-owned" }
      ],
      deleted: [] as Array<{ Key?: string | undefined; VersionId?: string | undefined }>
    };
    const marker = serializeStorageVnextOwnerMarker(
      createStorageVnextOwnerMarkerDocument(proof, proof.objectScope)
    );
    const client = createFakeS3Client(marker, state);
    const plane = createStorageVnextObjectPlane({ client, bucket: "owned-test-bucket" });

    expect((await plane.inspect(proof)).bootstrapState).toBe("incompatible");
    await plane.reset(proof);

    expect(await plane.verifyReset(proof)).toBe(true);
    expect(state.versions).toEqual([
      { Key: markerKey, VersionId: "marker-current", IsLatest: true }
    ]);
    expect(state.deleteMarkers).toEqual([]);
    expect(state.uploads).toEqual([]);
    expect(state.deleted.map((entry) => entry.VersionId).sort()).toEqual([
      "body-current",
      "deleted-old",
      "marker-old"
    ]);
  });

  it("resets an exact unversioned S3-compatible scope when version listing is unsupported", async () => {
    const markerKey = `${proof.objectScope}_run-owner.json`;
    const productKey = `${proof.objectScope}source/body.md`;
    const marker = serializeStorageVnextOwnerMarker(
      createStorageVnextOwnerMarkerDocument(proof, proof.objectScope)
    );
    const keys = new Set([markerKey, productKey]);
    const client = {
      async send(command: unknown) {
        if (command instanceof GetObjectCommand) {
          if (!keys.has(String(command.input.Key))) throw missingObject();
          return { Body: { transformToString: async () => marker } };
        }
        if (command instanceof ListObjectVersionsCommand) {
          throw Object.assign(new Error("ListObjectVersions not implemented"), {
            name: "NotImplemented",
            Code: "NotImplemented",
            $metadata: { httpStatusCode: 501 }
          });
        }
        if (command instanceof ListObjectsV2Command) {
          return {
            Contents: [...keys].map((Key) => ({ Key })),
            IsTruncated: false
          };
        }
        if (command instanceof ListMultipartUploadsCommand) {
          return { Uploads: [], IsTruncated: false };
        }
        if (command instanceof DeleteObjectsCommand) {
          for (const object of command.input.Delete?.Objects ?? []) {
            if (object.Key) keys.delete(object.Key);
          }
          return { Errors: [] };
        }
        throw new Error(`Unexpected S3 command: ${String(command)}`);
      }
    } as unknown as S3Client;
    const plane = createStorageVnextObjectPlane({ client, bucket: "owned-test-bucket" });

    expect((await plane.inspect(proof)).bootstrapState).toBe("incompatible");
    await plane.reset(proof);

    expect(await plane.verifyReset(proof)).toBe(true);
    expect(keys).toEqual(new Set([markerKey]));
  });

  it("refuses an S3 inventory result outside the exact prefix before deletion", async () => {
    const marker = serializeStorageVnextOwnerMarker(
      createStorageVnextOwnerMarkerDocument(proof, proof.objectScope)
    );
    const state = {
      versions: [
        {
          Key: `${proof.objectScope}_run-owner.json`,
          VersionId: "marker-current",
          IsLatest: true
        },
        { Key: "another-prefix/keep.md", VersionId: "outside", IsLatest: true }
      ],
      deleteMarkers: [],
      uploads: [],
      deleted: [] as Array<{ Key?: string | undefined; VersionId?: string | undefined }>
    };
    const plane = createStorageVnextObjectPlane({
      client: createFakeS3Client(marker, state),
      bucket: "owned-test-bucket"
    });

    await expect(plane.reset(proof)).rejects.toThrow(/not proven/u);
    expect(state.deleted).toEqual([]);
  });

  it("deletes only recorded Meilisearch indexes and tasks", async () => {
    const recordedIndex = `${proof.searchScope}active`;
    const unrelatedIndex = "focowiki_existing";
    const indexes = new Set([recordedIndex, unrelatedIndex]);
    const tasks = new Map<number, "enqueued" | "processing" | "succeeded" | "failed" | "canceled">([
      [41, "succeeded"]
    ]);
    const deletedIndexes: string[] = [];
    const deletedTaskFilters: number[][] = [];
    const client = createFakeSearchClient(indexes, tasks, deletedIndexes, deletedTaskFilters);
    const plane = createStorageVnextSearchPlane({
      client,
      receipt: {
        marker: createStorageVnextOwnerMarkerDocument(proof, proof.searchScope),
        recordedIndexUids: [recordedIndex],
        recordedTaskUids: [41]
      }
    });

    await plane.reset(proof);

    expect(await plane.verifyReset(proof)).toBe(true);
    expect(deletedIndexes).toEqual([recordedIndex]);
    expect(deletedTaskFilters).toEqual([[41]]);
    expect(indexes).toEqual(new Set([unrelatedIndex]));
  });

  it("deletes more than one bounded page of recorded Meilisearch tasks", async () => {
    const recordedIndex = `${proof.searchScope}active`;
    const indexes = new Set([recordedIndex]);
    const tasks = new Map(
      Array.from({ length: 1_001 }, (_value, index) =>
        [index + 1, "succeeded"] as const)
    );
    const deletedTaskFilters: number[][] = [];
    const plane = createStorageVnextSearchPlane({
      client: createFakeSearchClient(indexes, tasks, [], deletedTaskFilters),
      receipt: {
        marker: createStorageVnextOwnerMarkerDocument(proof, proof.searchScope),
        recordedIndexUids: [recordedIndex],
        recordedTaskUids: [...tasks.keys()]
      }
    });

    await plane.reset(proof);

    expect(await plane.verifyReset(proof)).toBe(true);
    expect(deletedTaskFilters.map((taskUids) => taskUids.length)).toEqual([1_000, 1]);
  });

  it("refuses an unrecorded run-prefixed Meilisearch index before deletion", async () => {
    const recordedIndex = `${proof.searchScope}recorded`;
    const unrecordedIndex = `${proof.searchScope}preexisting`;
    const indexes = new Set([recordedIndex, unrecordedIndex]);
    const deletedIndexes: string[] = [];
    const client = createFakeSearchClient(indexes, new Map(), deletedIndexes, []);
    const plane = createStorageVnextSearchPlane({
      client,
      receipt: {
        marker: createStorageVnextOwnerMarkerDocument(proof, proof.searchScope),
        recordedIndexUids: [recordedIndex],
        recordedTaskUids: []
      }
    });

    await expect(plane.reset(proof)).rejects.toThrow(/not proven/u);
    expect(deletedIndexes).toEqual([]);
  });

  it("discovers only exact run-prefixed Meilisearch indexes and their tasks", async () => {
    const ownedIndex = `${proof.searchScope}active`;
    const candidateIndex = `${proof.searchScope}candidate`;
    const receipt = await synchronizeStorageVnextSearchReceipt({
      proof,
      receipt: {
        marker: createStorageVnextOwnerMarkerDocument(proof, proof.searchScope),
        recordedIndexUids: [],
        recordedTaskUids: []
      },
      client: {
        async getRawIndexes() {
          return {
            results: [{ uid: ownedIndex }, { uid: "focowiki_existing" }],
            total: 2
          };
        },
        tasks: {
          async getTasks() {
            return {
              results: [
                { uid: 41, indexUid: ownedIndex },
                { uid: 42, indexUid: "focowiki_existing" },
                {
                  uid: 43,
                  indexUid: null,
                  details: { swaps: [{ indexes: [ownedIndex, candidateIndex] }] }
                }
              ],
              next: null
            };
          }
        }
      }
    });

    expect(receipt.recordedIndexUids).toEqual([ownedIndex]);
    expect(receipt.recordedTaskUids).toEqual([41, 43]);
  });

  it("discovers more than one bounded page of run-owned Meilisearch tasks", async () => {
    const ownedIndex = `${proof.searchScope}active`;
    const ownedTasks = Array.from({ length: 1_001 }, (_value, index) => ({
      uid: index + 1,
      indexUid: ownedIndex
    }));
    const receipt = await synchronizeStorageVnextSearchReceipt({
      proof,
      receipt: {
        marker: createStorageVnextOwnerMarkerDocument(proof, proof.searchScope),
        recordedIndexUids: [],
        recordedTaskUids: []
      },
      client: {
        async getRawIndexes() {
          return { results: [{ uid: ownedIndex }], total: 1 };
        },
        tasks: {
          async getTasks(input) {
            return input.from === undefined
              ? { results: ownedTasks.slice(0, 1_000), next: 1_001 }
              : { results: ownedTasks.slice(1_000), next: null };
          }
        }
      }
    });

    expect(receipt.recordedTaskUids).toHaveLength(1_001);
  });

  it("deletes only Redis keys under the exact run prefix and preserves its owner key", async () => {
    const ownerKey = `${proof.coordinationScope}_run-owner`;
    const productKey = `${proof.coordinationScope}locks:one`;
    const unrelatedKey = "focowiki:sessions:keep";
    const values = new Map([
      [ownerKey, serializeStorageVnextOwnerMarker(
        createStorageVnextOwnerMarkerDocument(proof, proof.coordinationScope)
      )],
      [productKey, "owned"],
      [unrelatedKey, "keep"]
    ]);
    const plane = createStorageVnextCoordinationPlane({
      get: async (key) => values.get(key) ?? null,
      del: async (key) => values.delete(key) ? 1 : 0,
      async *scanIterator(options) {
        const prefix = options.MATCH.slice(0, -1);
        yield [...values.keys()].filter((key) => key.startsWith(prefix));
      }
    });

    await plane.reset(proof);

    expect(await plane.verifyReset(proof)).toBe(true);
    expect(values.has(ownerKey)).toBe(true);
    expect(values.has(productKey)).toBe(false);
    expect(values.get(unrelatedKey)).toBe("keep");
  });
});

function createFakeS3Client(
  marker: string,
  state: {
    versions: Array<{ Key: string; VersionId: string; IsLatest: boolean }>;
    deleteMarkers: Array<{ Key: string; VersionId: string; IsLatest: boolean }>;
    uploads: Array<{ Key: string; UploadId: string }>;
    deleted: Array<{ Key?: string | undefined; VersionId?: string | undefined }>;
  }
): S3Client {
  return {
    async send(command: unknown) {
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToString: async () => marker } };
      }
      if (command instanceof ListObjectVersionsCommand) {
        return {
          Versions: state.versions,
          DeleteMarkers: state.deleteMarkers,
          IsTruncated: false
        };
      }
      if (command instanceof ListMultipartUploadsCommand) {
        return { Uploads: state.uploads, IsTruncated: false };
      }
      if (command instanceof DeleteObjectsCommand) {
        const objects = command.input.Delete?.Objects ?? [];
        state.deleted.push(...objects);
        const identities = new Set(objects.map((entry) => `${entry.Key}\0${entry.VersionId}`));
        state.versions = state.versions.filter(
          (entry) => !identities.has(`${entry.Key}\0${entry.VersionId}`)
        );
        state.deleteMarkers = state.deleteMarkers.filter(
          (entry) => !identities.has(`${entry.Key}\0${entry.VersionId}`)
        );
        return { Errors: [] };
      }
      if (command instanceof AbortMultipartUploadCommand) {
        state.uploads = state.uploads.filter(
          (entry) => entry.Key !== command.input.Key || entry.UploadId !== command.input.UploadId
        );
        return {};
      }
      throw new Error(`Unexpected S3 command: ${String(command)}`);
    }
  } as unknown as S3Client;
}

function missingObject(): Error {
  return Object.assign(new Error("missing"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 }
  });
}

function createFakeSearchClient(
  indexes: Set<string>,
  tasks: Map<number, "enqueued" | "processing" | "succeeded" | "failed" | "canceled">,
  deletedIndexes: string[],
  deletedTaskFilters: number[][]
): StorageVnextOwnedSearchClient {
  let nextTaskUid = 1_000;
  return {
    async getRawIndexes() {
      return { results: [...indexes].map((uid) => ({ uid })), total: indexes.size };
    },
    async deleteIndex(indexUid) {
      deletedIndexes.push(indexUid);
      indexes.delete(indexUid);
      return { taskUid: nextTaskUid++ };
    },
    tasks: {
      async getTasks(input) {
        return {
          results: input.uids.flatMap((uid) => {
            const status = tasks.get(uid);
            return status ? [{ uid, status }] : [];
          })
        };
      },
      async cancelTasks(input) {
        for (const uid of input.uids) tasks.set(uid, "canceled");
        return { taskUid: nextTaskUid++ };
      },
      async deleteTasks(input) {
        deletedTaskFilters.push([...input.uids]);
        for (const uid of input.uids) tasks.delete(uid);
        return { taskUid: nextTaskUid++ };
      },
      async waitForTask() {
        return {};
      }
    }
  };
}
