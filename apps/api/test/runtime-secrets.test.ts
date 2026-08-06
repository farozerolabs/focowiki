import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDeploymentSecret,
  loadDeploymentSecret,
  resolveDefaultRuntimeSecretDirectory
} from "../src/security/runtime-secrets.js";

describe("runtime deployment secrets", () => {
  it("uses the workspace root runtime secret directory from nested source paths", () => {
    const root = mkdtempSync(join(tmpdir(), "focowiki-runtime-root-"));
    const nested = join(root, "apps", "api");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");

    expect(resolveDefaultRuntimeSecretDirectory(nested)).toBe(join(root, "runtime-secrets"));
  });

  it("reuses a valid deployment secret without changing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "focowiki-runtime-valid-"));
    const secret = "a".repeat(43);
    writeFileSync(join(directory, "deployment.key"), `${secret}\n`, { mode: 0o600 });

    expect(loadDeploymentSecret({ directory })).toBe(secret);
    expect(assertDeploymentSecret({ directory })).toBe(secret);
    expect(readFileSync(join(directory, "deployment.key"), "utf8")).toBe(`${secret}\n`);
  });

  it("rejects an incompatible deployment secret without replacing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "focowiki-runtime-invalid-"));
    const path = join(directory, "deployment.key");
    writeFileSync(path, "invalid-secret\n", { mode: 0o600 });

    expect(() => loadDeploymentSecret({ directory }))
      .toThrow("Runtime deployment secret is invalid");
    expect(() => assertDeploymentSecret({ directory }))
      .toThrow("Runtime deployment secret is invalid");
    expect(readFileSync(path, "utf8")).toBe("invalid-secret\n");
  });

  it("keeps health validation read-only when the deployment secret is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "focowiki-runtime-missing-"));

    expect(() => assertDeploymentSecret({ directory }))
      .toThrow("Runtime deployment secret is unavailable");
  });
});
