import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";
import type {
  StorageVnextOwnedPlaneInspection,
  StorageVnextResetPlane
} from "./command.js";
import { StorageVnextOwnedScopeError } from "./owned-scope.js";

export function assertStorageVnextOwnedPlane(
  inspection: StorageVnextOwnedPlaneInspection,
  proof: StorageVnextOwnedScopeProof,
  plane: StorageVnextResetPlane,
  target: string
): void {
  if (
    inspection.plane !== plane
    || inspection.target !== target
    || !inspection.exists
    || !inspection.createdByRun
    || inspection.existedBeforeRun
    || inspection.broadTarget
    || inspection.ownerMarker !== proof.ownerMarker
    || inspection.unexpectedTargets.length > 0
  ) {
    throw new StorageVnextOwnedScopeError(`Owned ${plane} scope is not proven`);
  }
}
