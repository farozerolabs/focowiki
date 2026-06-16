import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = resolve(import.meta.dirname, "../../..");
const devComposeTemplatePath = resolve(rootDir, "docker-compose.dev.yml.example");
const deploymentComposeTemplatePath = resolve(rootDir, "docker-compose.yml.example");
const dockerfilePath = resolve(rootDir, "Dockerfile");
const dockerignorePath = resolve(rootDir, ".dockerignore");
const gitignorePath = resolve(rootDir, ".gitignore");
const packageJsonPath = resolve(rootDir, "package.json");
const devEnvTemplatePath = resolve(rootDir, ".env.dev.example");
const deploymentEnvTemplatePath = resolve(rootDir, ".env.example");

describe("Docker Compose infrastructure", () => {
  it("defines PostgreSQL and Redis services for local development in the dev template", () => {
    const compose = readFileSync(devComposeTemplatePath, "utf8");

    expect(compose).toContain("postgres:");
    expect(compose).toContain("image: postgres:18-alpine");
    expect(compose).toContain("pg_isready");
    expect(compose).toContain("postgres-data:");
    expect(compose).toContain("redis:");
    expect(compose).toContain("image: redis:8-alpine");
    expect(compose).toContain("redis-cli");
    expect(compose).toContain("redis-data:");
    expect(compose).not.toMatch(/\$\{[A-Z][A-Z0-9_]*:-/);
  });

  it("does not define embedded or in-process infrastructure fallbacks", () => {
    const compose = readFileSync(devComposeTemplatePath, "utf8");

    expect(compose).not.toMatch(/sqlite|embedded|in-memory|memory-backed/i);
  });

  it("defines the deployment stack as a committed Compose template", () => {
    const compose = readFileSync(deploymentComposeTemplatePath, "utf8");

    for (const service of ["admin:", "api:", "migrate:", "postgres:", "redis:"]) {
      expect(compose).toContain(service);
    }

    expect(compose).toContain("target: api");
    expect(compose).toContain("target: admin");
    expect(compose).toContain("apps/api/runtime/migrate.mjs");
    expect(compose).toContain("${ADMIN_UI_PORT:?Set ADMIN_UI_PORT in .env}:8080");
    expect(compose).toContain("${ADMIN_API_PORT:?Set ADMIN_API_PORT in .env}:${ADMIN_API_PORT:?Set ADMIN_API_PORT in .env}");
    expect(compose).toContain(
      "${PUBLIC_OPENAPI_PORT:?Set PUBLIC_OPENAPI_PORT in .env}:${PUBLIC_OPENAPI_PORT:?Set PUBLIC_OPENAPI_PORT in .env}"
    );
    expect(compose).toContain("postgres-data:");
    expect(compose).toContain("redis-data:");
    expect(compose).toContain("depends_on:");
    expect(compose).toContain("condition: service_healthy");
    expect(compose).toContain("env_file:");
    expect(compose).toContain("- .env");
    expect(compose).not.toContain("x-api-environment");
    expect(compose).not.toContain("S3_ENDPOINT:");
    expect(compose).not.toMatch(/\$\{[A-Z][A-Z0-9_]*:-/);
    expect(compose).not.toMatch(/(^|\n)\s+s3:|(^|\n)\s+s3-init:|minio|minio\/mc|s3-data:/i);
    expect(compose).not.toMatch(/sqlite|embedded|in-memory|memory-backed/i);
  });

  it("defines multi-stage Docker runtime targets without using the Vite dev server", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");

    expect(dockerfile).toContain("AS dependencies");
    expect(dockerfile).toContain("AS build");
    expect(dockerfile).toContain("AS api");
    expect(dockerfile).toContain("AS admin");
    expect(dockerfile).toContain("pnpm build");
    expect(dockerfile).toContain("pnpm --filter @focowiki/api build:runtime");
    expect(dockerfile).toContain("node");
    expect(dockerfile).toContain("apps/api/runtime/main.mjs");
    expect(dockerfile).toContain("apps/api/runtime/migrations");
    expect(dockerfile).not.toMatch(/pnpm\s+--filter\s+@focowiki\/admin\s+dev|vite\s+--host|pnpm\s+dev/);
  });

  it("keeps the API runtime image free from copied workspace node_modules", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const apiRuntime = dockerfile.split("FROM node:24-alpine AS api")[1]?.split("FROM nginx:1.29-alpine AS admin")[0] ?? "";

    expect(apiRuntime).not.toContain("node_modules");
    expect(apiRuntime).not.toContain("production-dependencies");
    expect(apiRuntime).toContain("apps/api/runtime");
  });

  it("excludes local-only files from the Docker build context", () => {
    const dockerignore = readFileSync(dockerignorePath, "utf8");

    for (const pattern of [
      ".env",
      ".env.*",
      "!.env.example",
      "!.env.dev.example",
      "docker-compose.yml",
      "docker-compose.dev.yml",
      "node_modules",
      ".git",
      "openspec",
      "ReferenceDocs",
      "tmp",
      "dist"
    ]) {
      expect(dockerignore).toContain(pattern);
    }
  });

  it("keeps real Compose files local while publishing only templates", () => {
    const gitignore = readFileSync(gitignorePath, "utf8");

    expect(gitignore).toContain("docker-compose.yml");
    expect(gitignore).toContain("docker-compose.dev.yml");
    expect(existsSync(deploymentComposeTemplatePath)).toBe(true);
    expect(existsSync(devComposeTemplatePath)).toBe(true);
  });

  it("defines explicit Compose cleanup scripts for local leftovers", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["compose:clean"]).toBe(
      "docker compose -f docker-compose.yml down --volumes --remove-orphans --rmi local"
    );
    expect(packageJson.scripts?.["compose:dev:clean"]).toBe(
      "docker compose -f docker-compose.dev.yml down --volumes --remove-orphans"
    );
  });

  it("documents separate dev and deployment environment templates", () => {
    const devEnv = readFileSync(devEnvTemplatePath, "utf8");
    const deploymentEnv = readFileSync(deploymentEnvTemplatePath, "utf8");

    expect(devEnv).toContain("APP_ENV=development");
    expect(devEnv).toContain("DATABASE_URL=postgres://focowiki:focowiki@127.0.0.1:55432/focowiki");
    expect(deploymentEnv).toContain("APP_ENV=production");
    expect(deploymentEnv).toContain("DATABASE_URL=postgres://");
    expect(deploymentEnv).toContain("REDIS_URL=redis://redis:6379/0");
    expect(deploymentEnv).toContain("S3_ENDPOINT=https://s3.example.com");
    expect(deploymentEnv).toContain("ADMIN_SESSION_SECRET=<generate-a-strong-session-secret>");
    expect(deploymentEnv).not.toContain("ADMIN_PASSWORD=change-me");
    expect(devEnv).not.toContain("PUBLIC_API_KEY");
    expect(devEnv).not.toContain("PUBLIC_API_AUTH_REQUIRED");
    expect(deploymentEnv).not.toContain("PUBLIC_API_KEY");
    expect(deploymentEnv).not.toContain("PUBLIC_API_AUTH_REQUIRED");
  });

  it("keeps env template keys and Compose references synchronized", () => {
    const devEnvKeys = parseEnvKeys(readFileSync(devEnvTemplatePath, "utf8"));
    const deploymentEnvKeys = parseEnvKeys(readFileSync(deploymentEnvTemplatePath, "utf8"));
    const deploymentComposeRefs = parseComposeEnvRefs(readFileSync(deploymentComposeTemplatePath, "utf8"));
    const devComposeRefs = parseComposeEnvRefs(readFileSync(devComposeTemplatePath, "utf8"));

    expect([...devEnvKeys].sort()).toEqual([...deploymentEnvKeys].sort());
    expect([...deploymentComposeRefs].filter((key) => !deploymentEnvKeys.has(key))).toEqual([]);
    expect([...devComposeRefs].filter((key) => !devEnvKeys.has(key))).toEqual([]);
  });
});

function parseEnvKeys(contents: string): Set<string> {
  return new Set(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter((key): key is string => key.length > 0)
  );
}

function parseComposeEnvRefs(contents: string): Set<string> {
  return new Set(
    [...contents.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)]
      .map((match) => match[1])
      .filter((key): key is string => typeof key === "string")
  );
}
