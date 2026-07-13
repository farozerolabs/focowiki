import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
});
