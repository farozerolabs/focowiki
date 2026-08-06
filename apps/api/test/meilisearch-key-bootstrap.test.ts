import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bootstrapMeilisearchKeys,
  createMeilisearchKeyUid
} from "../src/infrastructure/meilisearch/meilisearch-key-bootstrap.js";

describe("Meilisearch key bootstrap", () => {
  it("creates deterministic scoped keys and persists them as private files", async () => {
    const secretDirectory = mkdtempSync(
      join(tmpdir(), "focowiki-meilisearch-bootstrap-")
    );
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      requests.push({ method, path: url.pathname, body });

      if (method === "GET") {
        return Response.json(
          { message: "Key not found", code: "api_key_not_found" },
          { status: 404 }
        );
      }

      const key = requests.filter((request) => request.method === "POST").length === 1
        ? "runtime-search-key"
        : "runtime-metrics-key";
      return Response.json({ ...(body as object), key }, { status: 201 });
    }) as typeof globalThis.fetch;

    await bootstrapMeilisearchKeys({
      endpoint: "http://127.0.0.1:7700",
      masterKey: "a-secure-master-key",
      indexPrefix: "focowiki_prod",
      secretDirectory,
      fetch
    });

    const posts = requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toMatchObject({
      uid: createMeilisearchKeyUid("focowiki_prod", "runtime"),
      actions: [
        "search",
        "documents.*",
        "indexes.*",
        "indexes.swap",
        "stats.get",
        "tasks.get",
        "settings.*"
      ],
      indexes: ["focowiki_prod_*"],
      expiresAt: null
    });
    expect(posts[0]?.body).not.toHaveProperty("fileName");
    expect(posts[1]?.body).toMatchObject({
      uid: createMeilisearchKeyUid("focowiki_prod", "metrics"),
      actions: ["metrics.get", "stats.get", "tasks.delete", "tasks.get", "version"],
      indexes: ["*"],
      expiresAt: null
    });

    const apiKeyPath = join(secretDirectory, "meilisearch-api-key");
    const metricsKeyPath = join(secretDirectory, "meilisearch-metrics-key");
    expect(readFileSync(apiKeyPath, "utf8")).toBe("runtime-search-key\n");
    expect(readFileSync(metricsKeyPath, "utf8")).toBe("runtime-metrics-key\n");
    expect(statSync(apiKeyPath).mode & 0o777).toBe(0o600);
    expect(statSync(metricsKeyPath).mode & 0o777).toBe(0o600);
  });

  it("reuses existing keys without creating duplicates", async () => {
    const secretDirectory = mkdtempSync(
      join(tmpdir(), "focowiki-meilisearch-reuse-")
    );
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const isMetrics = url.pathname.endsWith(
        createMeilisearchKeyUid("focowiki", "metrics")
      );
      return Response.json({
        uid: url.pathname.split("/").at(-1),
        key: isMetrics ? "existing-metrics-key" : "existing-runtime-key",
        actions: isMetrics
          ? ["metrics.get", "stats.get", "tasks.delete", "tasks.get", "version"]
          : [
              "search",
              "documents.*",
              "indexes.*",
              "indexes.swap",
              "stats.get",
              "tasks.get",
              "settings.*"
            ],
        indexes: isMetrics ? ["*"] : ["focowiki_*"],
        expiresAt: null
      });
    }) as typeof globalThis.fetch;

    await bootstrapMeilisearchKeys({
      endpoint: "http://127.0.0.1:7700",
      masterKey: "a-secure-master-key",
      indexPrefix: "focowiki",
      secretDirectory,
      fetch
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(secretDirectory, "meilisearch-api-key"), "utf8"))
      .toBe("existing-runtime-key\n");
    expect(
      readFileSync(join(secretDirectory, "meilisearch-metrics-key"), "utf8")
    ).toBe("existing-metrics-key\n");
  });

  it("recreates a stable key when its immutable permission contract changed", async () => {
    const secretDirectory = mkdtempSync(
      join(tmpdir(), "focowiki-meilisearch-recreate-")
    );
    const runtimeUid = createMeilisearchKeyUid("focowiki", "runtime");
    const metricsUid = createMeilisearchKeyUid("focowiki", "metrics");
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      requests.push({ method, path: url.pathname, body });

      if (method === "GET" && url.pathname.endsWith(runtimeUid)) {
        return Response.json({
          uid: runtimeUid,
          key: "outdated-runtime-key",
          actions: ["search"],
          indexes: ["*"],
          expiresAt: null
        });
      }
      if (method === "GET" && url.pathname.endsWith(metricsUid)) {
        return Response.json({
          uid: metricsUid,
          key: "existing-metrics-key",
          actions: ["metrics.get", "stats.get", "tasks.delete", "tasks.get", "version"],
          indexes: ["*"],
          expiresAt: null
        });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({
        ...(body as object),
        key: "replacement-runtime-key"
      }, { status: 201 });
    }) as typeof globalThis.fetch;

    await bootstrapMeilisearchKeys({
      endpoint: "http://127.0.0.1:7700",
      masterKey: "a-secure-master-key",
      indexPrefix: "focowiki",
      secretDirectory,
      fetch
    });

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET /keys/${runtimeUid}`,
      `DELETE /keys/${runtimeUid}`,
      "POST /keys",
      `GET /keys/${metricsUid}`
    ]);
    expect(requests[2]?.body).toMatchObject({ uid: runtimeUid });
    expect(readFileSync(join(secretDirectory, "meilisearch-api-key"), "utf8"))
      .toBe("replacement-runtime-key\n");
  });

  it("validates administrator-provided external service keys before persisting them", async () => {
    const secretDirectory = mkdtempSync(
      join(tmpdir(), "focowiki-meilisearch-external-")
    );
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const authorization = new Headers(init?.headers).get("authorization");
      if (url.pathname === "/indexes" && authorization === "Bearer external-runtime-key") {
        return Response.json({ results: [], offset: 0, limit: 1, total: 0 });
      }
      if (url.pathname === "/version" && authorization === "Bearer external-metrics-key") {
        return Response.json({ pkgVersion: "1.51.0" });
      }
      if (url.pathname === "/metrics" && authorization === "Bearer external-metrics-key") {
        return new Response("meilisearch_db_size_bytes 0\n");
      }
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    });

    await bootstrapMeilisearchKeys({
      endpoint: "https://search.example.com",
      masterKey: "",
      indexPrefix: "focowiki",
      secretDirectory,
      providedApiKey: "external-runtime-key",
      providedMetricsApiKey: "external-metrics-key",
      fetch: fetch as typeof globalThis.fetch
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(secretDirectory, "meilisearch-api-key"), "utf8"))
      .toBe("external-runtime-key\n");
    expect(
      readFileSync(join(secretDirectory, "meilisearch-metrics-key"), "utf8")
    ).toBe("external-metrics-key\n");
  });

  it("does not persist incompatible external service keys", async () => {
    const secretDirectory = mkdtempSync(
      join(tmpdir(), "focowiki-meilisearch-invalid-external-")
    );
    const fetch = vi.fn(async () => (
      Response.json({ message: "Unauthorized" }, { status: 401 })
    ));

    await expect(bootstrapMeilisearchKeys({
      endpoint: "https://search.example.com",
      masterKey: "",
      indexPrefix: "focowiki",
      secretDirectory,
      providedApiKey: "invalid-runtime-key",
      providedMetricsApiKey: "invalid-metrics-key",
      fetch: fetch as typeof globalThis.fetch
    })).rejects.toThrow("Meilisearch runtime key validation failed with status 401");

    expect(existsSync(join(secretDirectory, "meilisearch-api-key"))).toBe(false);
    expect(existsSync(join(secretDirectory, "meilisearch-metrics-key"))).toBe(false);
  });
});
