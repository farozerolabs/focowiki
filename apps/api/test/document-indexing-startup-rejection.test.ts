import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_RUNTIME_ROLES,
  UnsupportedRuntimeRoleError,
  assertSupportedRuntimeRole
} from "../src/runtime/runtime-role-contract.js";
import { createBootstrapPlan } from "../src/db/migration-manifest.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

describe("document indexing startup rejection", () => {
  it.each([
    "storage-vnext-v1",
    "storage-vnext-v2",
    "storage-vnext-v4-continuous-pipeline",
    "unknown-generation"
  ])("rejects the old or unknown generation %s", (generation) => {
    expect(() => createBootstrapPlan(generation)).toThrow(
      "Unsupported database schema generation"
    );
  });

  it("accepts only the unified runtime role set", () => {
    for (const role of SUPPORTED_RUNTIME_ROLES) {
      expect(() => assertSupportedRuntimeRole(role)).not.toThrow();
    }
    for (const role of [
      "source-worker",
      "publication-worker",
      "maintenance-worker"
    ]) {
      expect(() => assertSupportedRuntimeRole(role)).toThrow(
        UnsupportedRuntimeRoleError
      );
    }
  });

  it("removes every legacy worker entrypoint", () => {
    for (const path of [
      "apps/api/src/source-worker-main.ts",
      "apps/api/src/publication-worker-main.ts",
      "apps/api/src/maintenance-worker-main.ts"
    ]) {
      expect(existsSync(resolve(workspaceRoot, path)), path).toBe(false);
    }
    expect(existsSync(resolve(workspaceRoot, "apps/api/src/worker-main.ts")))
      .toBe(true);
  });

  it("checks removed settings and legacy queue payloads in the startup signature", () => {
    const migrations = read("apps/api/src/db/migrations.ts");

    expect(migrations).toContain("runtime_setting_current");
    expect(migrations).toContain("settings_values->'sections' ? 'publication'");
    expect(migrations).toContain("work_kind IN ('source', 'graph', 'publication')");
    expect(migrations).toContain("checkpoint ?| ARRAY[");
    expect(migrations).toContain("'stageKind'");
    expect(migrations).toContain("'releaseRootPublicId'");
  });
});

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}
