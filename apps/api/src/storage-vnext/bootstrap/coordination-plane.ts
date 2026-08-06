import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";
import type {
  StorageVnextOwnedPlaneInspection,
  StorageVnextResetBootstrapPlane
} from "./command.js";
import { parseStorageVnextOwnerMarker } from "./owner-marker.js";
import { StorageVnextOwnedScopeError, validateStorageVnextOwnedScopeProof } from "./owned-scope.js";
import { assertStorageVnextOwnedPlane } from "./plane-safety.js";

export type StorageVnextOwnedRedisClient = {
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<string | string[]>;
};

export function createStorageVnextCoordinationPlane(
  client: StorageVnextOwnedRedisClient
): StorageVnextResetBootstrapPlane {
  return {
    plane: "coordination",
    inspect: (proof) => inspectCoordination(client, proof),
    async reset(proof) {
      const inspection = await inspectCoordination(client, proof);
      assertStorageVnextOwnedPlane(
        inspection,
        proof,
        "coordination",
        proof.coordinationScope
      );
      const ownerKey = `${proof.coordinationScope}_run-owner`;
      for (const key of await listScopeKeys(client, proof.coordinationScope)) {
        if (!key.startsWith(proof.coordinationScope)) {
          throw new StorageVnextOwnedScopeError("Redis scan returned a key outside the owned scope");
        }
        if (key !== ownerKey) await client.del(key);
      }
    },
    async verifyReset(proof) {
      const inspection = await inspectCoordination(client, proof);
      return isOwnedCoordination(inspection, proof)
        && inspection.bootstrapState === "current";
    },
    async bootstrap(proof) {
      const inspection = await inspectCoordination(client, proof);
      assertStorageVnextOwnedPlane(
        inspection,
        proof,
        "coordination",
        proof.coordinationScope
      );
      if (inspection.bootstrapState === "incompatible") {
        throw new StorageVnextOwnedScopeError("Owned Redis scope is not clean");
      }
    },
    async verifyBootstrap(proof) {
      return isOwnedCoordination(await inspectCoordination(client, proof), proof);
    }
  };
}

async function inspectCoordination(
  client: StorageVnextOwnedRedisClient,
  candidateProof: StorageVnextOwnedScopeProof
): Promise<StorageVnextOwnedPlaneInspection> {
  const proof = validateStorageVnextOwnedScopeProof(candidateProof);
  const ownerKey = `${proof.coordinationScope}_run-owner`;
  const [ownerValue, keys] = await Promise.all([
    client.get(ownerKey),
    listScopeKeys(client, proof.coordinationScope)
  ]);
  const marker = ownerValue
    ? parseStorageVnextOwnerMarker(ownerValue, proof, proof.coordinationScope)
    : null;
  const unexpectedTargets = keys.filter((key) => !key.startsWith(proof.coordinationScope));
  const productKeys = keys.filter((key) => key !== ownerKey);

  return {
    plane: "coordination",
    target: proof.coordinationScope,
    exists: ownerValue !== null,
    createdByRun: marker?.createdByRun ?? false,
    existedBeforeRun: marker?.existedBeforeRun ?? true,
    broadTarget: !proof.coordinationScope.endsWith(":"),
    bootstrapState: productKeys.length === 0 ? "current" : "incompatible",
    ownerMarker: marker?.ownerMarker ?? null,
    unexpectedTargets
  };
}

async function listScopeKeys(
  client: StorageVnextOwnedRedisClient,
  prefix: string
): Promise<string[]> {
  const keys = new Set<string>();
  for await (const entry of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
    for (const key of Array.isArray(entry) ? entry : [entry]) keys.add(key);
  }
  return [...keys].sort();
}

function isOwnedCoordination(
  inspection: StorageVnextOwnedPlaneInspection,
  proof: StorageVnextOwnedScopeProof
): boolean {
  try {
    assertStorageVnextOwnedPlane(
      inspection,
      proof,
      "coordination",
      proof.coordinationScope
    );
    return inspection.bootstrapState !== "incompatible";
  } catch {
    return false;
  }
}
