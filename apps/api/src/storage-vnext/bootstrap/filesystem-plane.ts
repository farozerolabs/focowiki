import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";
import type {
  StorageVnextOwnedPlaneInspection,
  StorageVnextResetBootstrapPlane
} from "./command.js";
import { parseStorageVnextOwnerMarker } from "./owner-marker.js";
import {
  StorageVnextOwnedScopeError,
  validateStorageVnextOwnedScopeProof
} from "./owned-scope.js";

const OWNER_MARKER_FILE = ".focowiki-run-owner.json";

export function createStorageVnextFilesystemPlane(
  plane: "runtime-secrets" | "temporary-files"
): StorageVnextResetBootstrapPlane {
  return {
    plane,
    inspect: (proof) => inspectFilesystemPlane(proof, plane),
    async reset(proof) {
      const inspection = await inspectFilesystemPlane(proof, plane);
      assertOwnedFilesystemInspection(inspection, proof);
      await rm(inspection.target, { recursive: true, force: true });
      await mkdir(inspection.target, { recursive: false, mode: 0o700 });
    },
    async verifyReset(proof) {
      const inspection = await inspectFilesystemPlane(proof, plane);
      return isOwnedFilesystemInspection(inspection, proof)
        && inspection.bootstrapState === "current";
    },
    async bootstrap(proof) {
      const inspection = await inspectFilesystemPlane(proof, plane);
      assertOwnedFilesystemInspection(inspection, proof);
      if (inspection.bootstrapState === "incompatible") {
        throw new StorageVnextOwnedScopeError("owned filesystem scope is not clean");
      }
      await mkdir(inspection.target, { recursive: false, mode: 0o700 }).catch((error) => {
        if (!isNodeErrorCode(error, "EEXIST")) throw error;
      });
    },
    async verifyBootstrap(proof) {
      const inspection = await inspectFilesystemPlane(proof, plane);
      return isOwnedFilesystemInspection(inspection, proof)
        && inspection.bootstrapState === "current";
    }
  };
}

async function inspectFilesystemPlane(
  candidateProof: StorageVnextOwnedScopeProof,
  plane: "runtime-secrets" | "temporary-files"
): Promise<StorageVnextOwnedPlaneInspection> {
  const proof = validateStorageVnextOwnedScopeProof(candidateProof);
  const target = join(
    proof.filesystemScope,
    plane === "temporary-files" ? "tmp" : "runtime-secrets"
  );
  const rootStatus = await safeLstat(proof.filesystemScope);
  const markerPath = join(proof.filesystemScope, OWNER_MARKER_FILE);
  const markerStatus = await safeLstat(markerPath);
  let marker = null;

  if (
    rootStatus?.isDirectory()
    && !rootStatus.isSymbolicLink()
    && markerStatus?.isFile()
    && !markerStatus.isSymbolicLink()
    && markerStatus.size <= 4_096
  ) {
    marker = parseStorageVnextOwnerMarker(
      await readFile(markerPath, "utf8"),
      proof,
      proof.filesystemScope
    );
  }

  const targetStatus = await safeLstat(target);
  const unsafeTarget = Boolean(
    targetStatus && (!targetStatus.isDirectory() || targetStatus.isSymbolicLink())
  );
  const childCount = targetStatus?.isDirectory() && !targetStatus.isSymbolicLink()
    ? (await readdir(target)).length
    : 0;

  return {
    plane,
    target,
    exists: Boolean(rootStatus && markerStatus),
    createdByRun: marker?.createdByRun ?? false,
    existedBeforeRun: marker?.existedBeforeRun ?? true,
    broadTarget: unsafeTarget,
    bootstrapState: unsafeTarget || childCount > 0
      ? "incompatible"
      : targetStatus
        ? "current"
        : "empty",
    ownerMarker: marker?.ownerMarker ?? null,
    unexpectedTargets: unsafeTarget ? [target] : []
  };
}

function assertOwnedFilesystemInspection(
  inspection: StorageVnextOwnedPlaneInspection,
  proof: StorageVnextOwnedScopeProof
): void {
  if (!isOwnedFilesystemInspection(inspection, proof)) {
    throw new StorageVnextOwnedScopeError("owned filesystem scope is not proven");
  }
}

function isOwnedFilesystemInspection(
  inspection: StorageVnextOwnedPlaneInspection,
  proof: StorageVnextOwnedScopeProof
): boolean {
  return inspection.exists
    && inspection.createdByRun
    && !inspection.existedBeforeRun
    && !inspection.broadTarget
    && inspection.ownerMarker === proof.ownerMarker
    && inspection.unexpectedTargets.length === 0;
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
