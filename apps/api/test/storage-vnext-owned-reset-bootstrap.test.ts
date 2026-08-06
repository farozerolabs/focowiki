import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  StorageVnextOwnedScopeError,
  createStorageVnextOwnedScopeProof,
  validateStorageVnextOwnedScopeProof
} from "../src/storage-vnext/bootstrap/owned-scope.js";
import {
  STORAGE_VNEXT_RESET_PLANE_ORDER,
  bootstrapStorageVnextOwnedScope,
  resetStorageVnextOwnedScope,
  type StorageVnextResetBootstrapPlane
} from "../src/storage-vnext/bootstrap/command.js";

const runId = "svnext-20260801T172700Z-a1b2c3d4e5f6";
const nonceHash = "c".repeat(64);

function createProof() {
  return createStorageVnextOwnedScopeProof({
    runId,
    nonceHash,
    createdAt: "2026-08-01T09:27:00.000Z",
    filesystemScope: join(tmpdir(), runId)
  });
}

describe("storage vNext run-owned reset and bootstrap", () => {
  it("derives every exact provider scope from one canonical run identity", () => {
    const proof = createProof();
    const token = "20260801t172700z_a1b2c3d4e5f6";

    expect(proof.postgresScope).toBe(`focowiki_svnext_${token}`);
    expect(proof.objectScope).toBe(`focowiki-validation/${runId}/`);
    expect(proof.searchScope).toBe(`svnext_${token}_`);
    expect(proof.coordinationScope).toBe(`focowiki:validation:${runId}:`);
    expect(proof.filesystemScope).toBe(join(tmpdir(), runId));
    expect(proof.ownerMarker).toMatch(/^[a-f0-9]{64}$/u);
    expect(proof.proofChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(validateStorageVnextOwnedScopeProof(proof)).toEqual(proof);
  });

  it.each([
    ["malformed run identity", { runId: "svnext-local" }],
    ["broad PostgreSQL target", { postgresScope: "postgres" }],
    ["bucket-root object target", { objectScope: "" }],
    ["unscoped search target", { searchScope: "svnext_" }],
    ["default Redis target", { coordinationScope: "focowiki:" }],
    ["workspace-like filesystem target", { filesystemScope: "/" }],
    ["mismatched owner marker", { ownerMarker: "0".repeat(64) }],
    ["mismatched proof checksum", { proofChecksum: "0".repeat(64) }]
  ])("refuses %s before inspecting a store", (_name, change) => {
    expect(() => validateStorageVnextOwnedScopeProof({
      ...createProof(),
      ...change
    })).toThrow(StorageVnextOwnedScopeError);
  });

  it("preflights every plane before the first reset mutation", async () => {
    const proof = createProof();
    const events: string[] = [];
    const planes = createPlanes(proof, events);

    await resetStorageVnextOwnedScope({ proof, planes });

    expect(events.slice(0, STORAGE_VNEXT_RESET_PLANE_ORDER.length)).toEqual(
      STORAGE_VNEXT_RESET_PLANE_ORDER.map((plane) => `inspect:${plane}`)
    );
    for (const plane of STORAGE_VNEXT_RESET_PLANE_ORDER) {
      expect(events).toContain(`reset:${plane}`);
      expect(events).toContain(`verify-reset:${plane}`);
    }
  });

  it("refuses every mutation when one target is missing, pre-existing, broad, or unproven", async () => {
    const proof = createProof();

    for (const unsafeInspection of [
      { exists: false },
      { createdByRun: false },
      { existedBeforeRun: true },
      { broadTarget: true },
      { ownerMarker: null },
      { ownerMarker: "f".repeat(64) },
      { unexpectedTargets: ["pre-existing-target"] }
    ]) {
      const events: string[] = [];
      const planes = createPlanes(proof, events, {
        search: unsafeInspection
      });

      await expect(resetStorageVnextOwnedScope({ proof, planes }))
        .rejects.toBeInstanceOf(StorageVnextOwnedScopeError);
      expect(events.some((event) => event.startsWith("reset:"))).toBe(false);
    }
  });

  it("revalidates exact ownership immediately before each reset mutation", async () => {
    const proof = createProof();
    const events: string[] = [];
    const planes = createPlanes(proof, events);

    await resetStorageVnextOwnedScope({ proof, planes });

    for (const plane of STORAGE_VNEXT_RESET_PLANE_ORDER) {
      const resetIndex = events.indexOf(`reset:${plane}`);
      expect(events[resetIndex - 1]).toBe(`inspect:${plane}`);
    }
  });

  it("bootstraps only empty owned planes and verifies every result", async () => {
    const proof = createProof();
    const events: string[] = [];
    const planes = createPlanes(proof, events);

    await bootstrapStorageVnextOwnedScope({ proof, planes });

    for (const plane of STORAGE_VNEXT_RESET_PLANE_ORDER) {
      expect(events).toContain(`bootstrap:${plane}`);
      expect(events).toContain(`verify-bootstrap:${plane}`);
    }
  });

  it("does not bootstrap any plane when preflight finds nonempty state", async () => {
    const proof = createProof();
    const events: string[] = [];
    const planes = createPlanes(proof, events, {
      postgres: { bootstrapState: "incompatible" }
    });

    await expect(bootstrapStorageVnextOwnedScope({ proof, planes }))
      .rejects.toBeInstanceOf(StorageVnextOwnedScopeError);
    expect(events.some((event) => event.startsWith("bootstrap:"))).toBe(false);
  });

  it("allows deterministic repeated bootstrap of a current owned scope", async () => {
    const proof = createProof();
    const events: string[] = [];
    const planes = createPlanes(proof, events, {
      postgres: { bootstrapState: "current" }
    });

    await expect(bootstrapStorageVnextOwnedScope({ proof, planes })).resolves.toMatchObject({
      action: "bootstrap",
      completedPlanes: STORAGE_VNEXT_RESET_PLANE_ORDER
    });
  });
});

function createPlanes(
  proof: ReturnType<typeof createProof>,
  events: string[],
  overrides: Partial<Record<
    (typeof STORAGE_VNEXT_RESET_PLANE_ORDER)[number],
    Partial<Awaited<ReturnType<StorageVnextResetBootstrapPlane["inspect"]>>>
  >> = {}
): StorageVnextResetBootstrapPlane[] {
  return STORAGE_VNEXT_RESET_PLANE_ORDER.map((plane) => ({
    plane,
    async inspect() {
      events.push(`inspect:${plane}`);
      return {
        plane,
        target: expectedTarget(proof, plane),
        exists: true,
        createdByRun: true,
        existedBeforeRun: false,
        broadTarget: false,
        bootstrapState: "empty",
        ownerMarker: proof.ownerMarker,
        unexpectedTargets: [],
        ...overrides[plane]
      };
    },
    async reset() {
      events.push(`reset:${plane}`);
    },
    async verifyReset() {
      events.push(`verify-reset:${plane}`);
      return true;
    },
    async bootstrap() {
      events.push(`bootstrap:${plane}`);
    },
    async verifyBootstrap() {
      events.push(`verify-bootstrap:${plane}`);
      return true;
    }
  }));
}

function expectedTarget(
  proof: ReturnType<typeof createProof>,
  plane: (typeof STORAGE_VNEXT_RESET_PLANE_ORDER)[number]
): string {
  switch (plane) {
    case "postgres": return proof.postgresScope;
    case "object": return proof.objectScope;
    case "search": return proof.searchScope;
    case "coordination": return proof.coordinationScope;
    case "runtime-secrets": return join(proof.filesystemScope, "runtime-secrets");
    case "temporary-files": return join(proof.filesystemScope, "tmp");
  }
}
