import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const contractPath = "apps/api/src/storage-vnext/transactions/ports.ts";

function readContract(): string {
  return readFileSync(resolve(workspaceRoot, contractPath), "utf8");
}

describe("storage vNext cross-store contract", () => {
  it("defines durable phases, identity, checkpoints, visibility, and compensation ports", () => {
    expect(existsSync(resolve(workspaceRoot, contractPath)), contractPath).toBe(true);
    if (!existsSync(resolve(workspaceRoot, contractPath))) return;

    const source = readContract();
    for (const name of [
      "StorageVnextCrossStorePhase",
      "StorageVnextOperationIdentity",
      "StorageVnextCrossStoreCheckpoint",
      "StorageVnextActiveSnapshot",
      "StorageVnextCrossStoreTransactionPort",
      "StorageVnextPublicVisibilityPort",
      "StorageVnextCompensationPort"
    ]) {
      expect(source, name).toMatch(new RegExp(`export\\s+type\\s+${name}\\b`, "u"));
    }
  });

  it("makes one PostgreSQL active-snapshot CAS the only public visibility point", () => {
    if (!existsSync(resolve(workspaceRoot, contractPath))) return;
    const source = readContract();
    expect(source).toContain("compareAndSwapActiveSnapshot");
    expect(source).toContain("releaseRootPublicId");
    expect(source).toContain("searchProjectionPublicId");
    expect(source).toContain("expectedActiveRevision");
    expect(source).toContain("publiclyVisibleAt");
    expect(source).not.toContain("markObjectPublic");
    expect(source).not.toContain("markSearchPublic");
  });

  it("requires stable idempotency and restartable compensation", () => {
    if (!existsSync(resolve(workspaceRoot, contractPath))) return;
    const source = readContract();
    for (const action of [
      "release_candidate_owner",
      "delete_unowned_body",
      "delete_search_candidate",
      "remove_coordination",
      "reconcile_unresolved"
    ]) {
      expect(source).toContain(`"${action}"`);
    }
    expect(source).toContain("idempotency");
    expect(source).toContain("expectedPhase");
    expect(source).toContain("checkpoint");
  });

  it("keeps transaction contracts independent from concrete stores and API/UI adapters", () => {
    if (!existsSync(resolve(workspaceRoot, contractPath))) return;
    expect(readContract()).not.toMatch(
      /\/db\/|\/infrastructure\/|\/redis\/|\/storage\/s3|\/admin\/|\/developer-openapi\/|hono|postgres|meilisearch|@aws-sdk/u
    );
  });
});
