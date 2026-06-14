import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const composePath = resolve(import.meta.dirname, "../../../docker-compose.yml");

describe("Docker Compose infrastructure", () => {
  it("defines PostgreSQL and Redis services with health checks and named volumes", () => {
    const compose = readFileSync(composePath, "utf8");

    expect(compose).toContain("postgres:");
    expect(compose).toContain("image: postgres:18-alpine");
    expect(compose).toContain("pg_isready");
    expect(compose).toContain("postgres-data:");
    expect(compose).toContain("redis:");
    expect(compose).toContain("image: redis:8-alpine");
    expect(compose).toContain("redis-cli");
    expect(compose).toContain("redis-data:");
  });

  it("does not define embedded or in-process infrastructure fallbacks", () => {
    const compose = readFileSync(composePath, "utf8");

    expect(compose).not.toMatch(/sqlite|embedded|in-memory|memory-backed/i);
  });
});
