import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

describe("storage vNext module graph contract", () => {
  it("has one public activation owner", () => {
    const transactionSource = readWorkspaceFile(
      "apps/api/src/storage-vnext/transactions/ports.ts"
    );
    const releaseSource = readWorkspaceFile(
      "apps/api/src/storage-vnext/release/ports.ts"
    );
    const searchSource = readWorkspaceFile(
      "apps/api/src/storage-vnext/search/ports.ts"
    );

    expect(transactionSource).toContain("compareAndSwapActiveSnapshot");
    expect(releaseSource).not.toContain("compareAndSwapActive");
    expect(searchSource).not.toContain("activateCandidate");
  });

  it("uses terminal convergence as the only cleanup application contract", () => {
    const genericCleanupPath = resolve(
      workspaceRoot,
      "apps/api/src/storage-vnext/cleanup/ports.ts"
    );
    const architectureSource = readWorkspaceFile(
      "apps/api/test/storage-vnext-architecture-contract.test.ts"
    );
    const convergenceSource = readWorkspaceFile(
      "apps/api/src/storage-vnext/cleanup/terminal-convergence.ts"
    );

    expect(existsSync(genericCleanupPath)).toBe(false);
    expect(architectureSource).toContain("cleanup/terminal-convergence.ts");
    expect(architectureSource).toContain("StorageVnextTerminalConvergencePort");
    expect(convergenceSource).toContain("StorageVnextTerminalConvergencePort");
  });

  it("does not add factories, registries, service locators, or barrel modules", () => {
    const storageVnextRoot = resolve(workspaceRoot, "apps/api/src/storage-vnext");
    for (const speculativeFile of [
      "factory.ts",
      "registry.ts",
      "service-locator.ts",
      "index.ts",
      "deletion/index.ts",
      "maintenance/index.ts",
      "mutation/index.ts",
      "publication/index.ts",
      "runtime/index.ts"
    ]) {
      expect(existsSync(resolve(storageVnextRoot, speculativeFile)), speculativeFile).toBe(false);
    }
  });
});
