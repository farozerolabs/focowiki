import { join } from "node:path";
import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";
import {
  StorageVnextOwnedScopeError,
  validateStorageVnextOwnedScopeProof
} from "./owned-scope.js";

export const STORAGE_VNEXT_RESET_PLANE_ORDER = [
  "search",
  "object",
  "coordination",
  "postgres",
  "runtime-secrets",
  "temporary-files"
] as const;

export type StorageVnextResetPlane =
  (typeof STORAGE_VNEXT_RESET_PLANE_ORDER)[number];

export type StorageVnextOwnedPlaneInspection = {
  plane: StorageVnextResetPlane;
  target: string;
  exists: boolean;
  createdByRun: boolean;
  existedBeforeRun: boolean;
  broadTarget: boolean;
  bootstrapState: "empty" | "current" | "incompatible";
  ownerMarker: string | null;
  unexpectedTargets: string[];
};

export type StorageVnextResetBootstrapPlane = {
  plane: StorageVnextResetPlane;
  inspect(proof: StorageVnextOwnedScopeProof): Promise<StorageVnextOwnedPlaneInspection>;
  reset(proof: StorageVnextOwnedScopeProof): Promise<void>;
  verifyReset(proof: StorageVnextOwnedScopeProof): Promise<boolean>;
  bootstrap(proof: StorageVnextOwnedScopeProof): Promise<void>;
  verifyBootstrap(proof: StorageVnextOwnedScopeProof): Promise<boolean>;
};

export type StorageVnextOwnedScopeCommandResult = {
  runId: string;
  action: "reset" | "bootstrap";
  completedPlanes: StorageVnextResetPlane[];
};

export async function resetStorageVnextOwnedScope(input: {
  proof: StorageVnextOwnedScopeProof;
  planes: StorageVnextResetBootstrapPlane[];
}): Promise<StorageVnextOwnedScopeCommandResult> {
  const proof = validateStorageVnextOwnedScopeProof(input.proof);
  const planes = indexPlanes(input.planes);
  await preflight(proof, planes, false);
  const completedPlanes: StorageVnextResetPlane[] = [];

  for (const planeName of STORAGE_VNEXT_RESET_PLANE_ORDER) {
    const plane = planes.get(planeName)!;
    assertInspection(proof, await plane.inspect(proof), false);
    await plane.reset(proof);
    if (!await plane.verifyReset(proof)) {
      throw new StorageVnextOwnedScopeError(
        `Owned ${planeName} scope did not reach its exact reset state`
      );
    }
    completedPlanes.push(planeName);
  }

  return { runId: proof.runId, action: "reset", completedPlanes };
}

export async function bootstrapStorageVnextOwnedScope(input: {
  proof: StorageVnextOwnedScopeProof;
  planes: StorageVnextResetBootstrapPlane[];
}): Promise<StorageVnextOwnedScopeCommandResult> {
  const proof = validateStorageVnextOwnedScopeProof(input.proof);
  const planes = indexPlanes(input.planes);
  await preflight(proof, planes, true);
  const completedPlanes: StorageVnextResetPlane[] = [];

  for (const planeName of STORAGE_VNEXT_RESET_PLANE_ORDER) {
    const plane = planes.get(planeName)!;
    assertInspection(proof, await plane.inspect(proof), true);
    await plane.bootstrap(proof);
    if (!await plane.verifyBootstrap(proof)) {
      throw new StorageVnextOwnedScopeError(
        `Owned ${planeName} scope did not reach its exact bootstrap state`
      );
    }
    completedPlanes.push(planeName);
  }

  return { runId: proof.runId, action: "bootstrap", completedPlanes };
}

async function preflight(
  proof: StorageVnextOwnedScopeProof,
  planes: ReadonlyMap<StorageVnextResetPlane, StorageVnextResetBootstrapPlane>,
  requireEmpty: boolean
): Promise<void> {
  for (const planeName of STORAGE_VNEXT_RESET_PLANE_ORDER) {
    assertInspection(proof, await planes.get(planeName)!.inspect(proof), requireEmpty);
  }
}

function indexPlanes(
  input: StorageVnextResetBootstrapPlane[]
): Map<StorageVnextResetPlane, StorageVnextResetBootstrapPlane> {
  const planes = new Map<StorageVnextResetPlane, StorageVnextResetBootstrapPlane>();
  for (const plane of input) {
    if (!STORAGE_VNEXT_RESET_PLANE_ORDER.includes(plane.plane) || planes.has(plane.plane)) {
      throw new StorageVnextOwnedScopeError("Reset/bootstrap planes must be unique and recognized");
    }
    planes.set(plane.plane, plane);
  }
  if (planes.size !== STORAGE_VNEXT_RESET_PLANE_ORDER.length) {
    throw new StorageVnextOwnedScopeError("Reset/bootstrap requires all exact storage planes");
  }
  return planes;
}

function assertInspection(
  proof: StorageVnextOwnedScopeProof,
  inspection: StorageVnextOwnedPlaneInspection,
  requireEmpty: boolean
): void {
  const expectedTarget = expectedTargetForPlane(proof, inspection.plane);
  if (
    inspection.target !== expectedTarget
    || !inspection.exists
    || !inspection.createdByRun
    || inspection.existedBeforeRun
    || inspection.broadTarget
    || inspection.ownerMarker !== proof.ownerMarker
    || inspection.unexpectedTargets.length > 0
    || (requireEmpty && inspection.bootstrapState === "incompatible")
  ) {
    throw new StorageVnextOwnedScopeError(
      `Owned ${inspection.plane} scope is missing, broad, pre-existing, nonempty, or unproven`
    );
  }
}

function expectedTargetForPlane(
  proof: StorageVnextOwnedScopeProof,
  plane: StorageVnextResetPlane
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
