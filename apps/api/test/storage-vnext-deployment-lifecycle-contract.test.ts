import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const contractPath = "apps/api/src/storage-vnext/lifecycle/ports.ts";

function readContract(): string {
  return readFileSync(resolve(workspaceRoot, contractPath), "utf8");
}

describe("storage vNext deployment lifecycle contract", () => {
  it("defines owned scope, bootstrap, rebuild, validation, cutover, rollback, and retirement ports", () => {
    expect(existsSync(resolve(workspaceRoot, contractPath)), contractPath).toBe(true);
    if (!existsSync(resolve(workspaceRoot, contractPath))) return;

    const source = readContract();
    for (const name of [
      "StorageVnextOwnedScopeProof",
      "StorageVnextDeploymentPhase",
      "StorageVnextValidationEvidence",
      "StorageVnextBootstrapPort",
      "StorageVnextRebuildPort",
      "StorageVnextValidationPort",
      "StorageVnextCutoverPort",
      "StorageVnextRetirementPort"
    ]) {
      expect(source, name).toMatch(new RegExp(`export\\s+type\\s+${name}\\b`, "u"));
    }
  });

  it("requires clean initialization and unique run ownership", () => {
    if (!existsSync(resolve(workspaceRoot, contractPath))) return;
    const source = readContract();
    for (const token of [
      "runId",
      "ownerMarker",
      "postgresScope",
      "objectScope",
      "searchScope",
      "coordinationScope",
      "initializeClean",
      "refuseUnownedScope"
    ]) {
      expect(source).toContain(token);
    }
  });

  it("defines one-way phases and explicit rollback/retirement evidence", () => {
    if (!existsSync(resolve(workspaceRoot, contractPath))) return;
    const source = readContract();
    for (const phase of [
      "empty",
      "bootstrapped",
      "rebuilding",
      "validated",
      "active",
      "rollback_window",
      "retirement_ready",
      "retired"
    ]) {
      expect(source).toContain(`"${phase}"`);
    }
    expect(source).toContain("activateValidated");
    expect(source).toContain("rollbackToLegacyBackup");
    expect(source).toContain("acceptedWriteExportPublicId");
    expect(source).toContain("retireLegacyStorage");
    expect(source).toContain("restorableBackupPublicId");
  });

  it("contains no dual-write, compatibility-reader, or mixed-schema contract", () => {
    if (!existsSync(resolve(workspaceRoot, contractPath))) return;
    expect(readContract()).not.toMatch(
      /dualWrite|writeLegacy|readLegacy|compatibilityReader|mixedSchema|legacyFallback/u
    );
  });

  it("keeps lifecycle ports independent from concrete stores and API/UI adapters", () => {
    if (!existsSync(resolve(workspaceRoot, contractPath))) return;
    expect(readContract()).not.toMatch(
      /from\s+["'][^"']*(?:\/db\/|\/infrastructure\/|\/redis\/|\/storage\/s3|\/admin\/|\/developer-openapi\/)|from\s+["'](?:hono|postgres|redis|meilisearch|@aws-sdk\/)/u
    );
  });
});
