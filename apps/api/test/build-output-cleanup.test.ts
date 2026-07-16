import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const apiRoot = resolve(import.meta.dirname, "..");

describe("API build output cleanup", () => {
  it("removes stale TypeScript output before every API build", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(apiRoot, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    const cleanScript = readFileSync(
      resolve(apiRoot, "scripts/clean-dist.mjs"),
      "utf8"
    );

    expect(packageJson.scripts?.prebuild).toBe("node scripts/clean-dist.mjs");
    expect(cleanScript).toContain('rm(resolve(apiRoot, "dist")');
    expect(cleanScript).toContain("recursive: true");
  });
});
