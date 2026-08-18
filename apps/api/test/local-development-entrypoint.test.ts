import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

describe("local development entrypoint", () => {
  it("starts every long-running product role from the documented command", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.dev).toBe(
      "node --import tsx scripts/dev-runtime.ts"
    );
    expect(existsSync(resolve(workspaceRoot, "scripts/dev-runtime.ts"))).toBe(true);

    const runtime = read("scripts/dev-runtime.ts");
    for (const entrypoint of [
      "apps/api/src/main.ts",
      "apps/api/src/worker-main.ts"
    ]) {
      expect(runtime, entrypoint).toContain(entrypoint);
    }
    expect(runtime).not.toMatch(/(?:source|publication|maintenance)-worker-main/u);
    expect(runtime).toContain("@focowiki/admin");
  });

  it("uses one explicit release-tag placeholder in deployment examples", () => {
    for (const path of [
      "README.md",
      "README.zh-CN.md",
      "docs/deployment/docker-compose.md",
      "docs/zh-CN/deployment/docker-compose.md"
    ]) {
      const document = read(path);
      expect(document, path).not.toMatch(/focowiki-(?:api|admin|source-worker):0\./u);
      expect(document, path).toContain("focowiki-api:<release-tag>");
      expect(document, path).toContain("focowiki-admin:<release-tag>");
      expect(document, path).not.toContain("focowiki-source-worker:<release-tag>");
    }
  });

  it("prepares the pinned Python runtime before starting local workers", () => {
    for (const path of ["README.md", "README.zh-CN.md"]) {
      const document = read(path);
      expect(document, path).toContain("python3.12 -m venv .venv");
      expect(document, path).toContain(
        "python -m pip install -r apps/api/python/requirements.lock"
      );
      expect(document.indexOf("python3.12 -m venv .venv"), path).toBeLessThan(
        document.indexOf("pnpm dev")
      );
    }
  });

  it("can build the local search initializer before an infrastructure-only startup", () => {
    const compose = read("docker-compose.local.yml.example");
    const searchInit = compose.match(
      /\n  search-init:([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:|\nvolumes:)/u
    )?.[1] ?? "";

    expect(searchInit).toContain("image: focowiki-api:dev");
    expect(searchInit).toContain("build:");
    expect(searchInit).toContain("target: api");
  });
});
