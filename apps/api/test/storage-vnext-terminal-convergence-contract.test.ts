import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const contractPath = "apps/api/src/storage-vnext/cleanup/terminal-convergence.ts";
const adapterFiles = {
  upload: "upload.ts",
  source_processing: "source-processing.ts",
  publication: "publication.ts",
  mutation: "mutation.ts",
  hard_delete: "hard-delete.ts",
  search_rebuild: "search-rebuild.ts",
  projection_repair: "projection-repair.ts",
  reconciliation: "reconciliation.ts",
  webhook: "webhook.ts",
  security: "security.ts"
} as const;

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

describe("storage vNext terminal convergence contract", () => {
  it("defines one terminal outcome and cleanup receipt contract", () => {
    expect(existsSync(resolve(workspaceRoot, contractPath)), contractPath).toBe(true);
    if (!existsSync(resolve(workspaceRoot, contractPath))) return;

    const source = read(contractPath);
    for (const name of [
      "StorageVnextTerminalOutcome",
      "StorageVnextTerminalContext",
      "StorageVnextCleanupTarget",
      "StorageVnextCleanupReceipt",
      "StorageVnextTerminalCleanupAdapter",
      "StorageVnextTerminalConvergencePort"
    ]) {
      expect(source, name).toMatch(new RegExp(`export\\s+type\\s+${name}\\b`, "u"));
    }
    for (const outcome of [
      "completed",
      "failed",
      "cancelled",
      "superseded",
      "timed_out",
      "deleted"
    ]) {
      expect(source).toContain(`"${outcome}"`);
    }
  });

  it("keeps every cleanup adapter in its own business-domain module", () => {
    for (const [domain, file] of Object.entries(adapterFiles)) {
      const path = `apps/api/src/storage-vnext/cleanup/adapters/${file}`;
      expect(existsSync(resolve(workspaceRoot, path)), `${domain}: ${path}`).toBe(true);
      if (!existsSync(resolve(workspaceRoot, path))) continue;

      const source = read(path);
      expect(source, domain).toContain('from "../terminal-convergence.js"');
      expect(source, domain).toContain(`"${domain}"`);
      expect(source.split("\n").length, domain).toBeLessThanOrEqual(80);
      expect(source, domain).not.toMatch(
        /from\s+["'][^"']*(?:\/db\/|\/infrastructure\/|\/redis\/|\/storage\/s3)|from\s+["'](?:hono|postgres|redis|meilisearch|@aws-sdk\/)/u
      );
    }
  });

  it("keeps the shared convergence contract independent from domain adapters", () => {
    if (!existsSync(resolve(workspaceRoot, contractPath))) return;
    const source = read(contractPath);
    expect(source).not.toContain("/adapters/");
    expect(source).not.toMatch(
      /upload|source_processing|publication|mutation|hard_delete|search_rebuild|projection_repair|reconciliation|webhook|security/u
    );
  });
});
