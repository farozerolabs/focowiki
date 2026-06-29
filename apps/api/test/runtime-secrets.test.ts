import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
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

  it("migrates an existing nested deployment key to the workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "focowiki-runtime-root-"));
    const nested = join(root, "apps", "api");
    const legacyDirectory = join(nested, "runtime-secrets");
    const secret = randomBytes(32).toString("base64url");
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(legacyDirectory, "deployment.key"), `${secret}\n`);

    const directory = resolveDefaultRuntimeSecretDirectory(nested);

    expect(directory).toBe(join(root, "runtime-secrets"));
    expect(readFileSync(join(directory, "deployment.key"), "utf8").trim()).toBe(secret);
    expect(loadDeploymentSecret({ directory })).toBe(secret);
  });
});
