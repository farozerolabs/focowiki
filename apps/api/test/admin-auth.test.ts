import { describe, expect, it } from "vitest";
import { createAdminApiApp, createApiApp } from "../src/server.js";
import { resolveSecurityConfig, type RuntimeConfig } from "../src/config.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  MemoryRedisCommandClient,
  withTrustedAdminOrigin
} from "./support/session.js";

const config: RuntimeConfig = {
  admin: {
    username: "admin",
    password: "admin-secret",
  },
  database: {
    url: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki"
  },
  redis: {
    url: "redis://127.0.0.1:6379/0"
  },
  ports: {
    adminApi: 43_000,
    adminUi: 43_100,
    publicOpenApi: 43_200
  },
  publicApi: {
    baseUrl: "https://kb.example.com"
  },
  storage: {
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "focowiki",
    accessKeyId: "s3-access",
    secretAccessKey: "s3-secret",
    prefix: "tenant/demo",
    forcePathStyle: true
  },
  publication: {
    mode: "batch",
    batchSize: 300,
    intervalSeconds: 300,
    indexShardSize: 1_000,
    linkIndexShardSize: 1_000,
    manifestShardSize: 1_000,
    graphEdgeShardSize: 5_000,
    graphCandidateLimit: 200,
    graphMaintenanceBatchSize: 500,
    rootSummaryLimit: 500
  },
  pagination: {
    defaultPageSize: 50,
    maxPageSize: 200,
    treeDefaultPageSize: 100,
    treeMaxPageSize: 500,
    cursorTtlSeconds: 900,
    generatedContentMaxBytes: 10_485_760
  },
  model: {
    enabled: false
  },
  corsOrigins: []
};

describe("Admin API auth", () => {
  it("accepts valid username and password credentials and sets an HTTP-only session cookie", async () => {
    const redisClient = new MemoryRedisCommandClient();
    const app = createApiApp({
      config,
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" })
    });
    const response = await app.request("/admin/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ username: "admin", password: "admin-secret" })
    });
    const cookie = response.headers.get("set-cookie") ?? "";

    await expect(response.json()).resolves.toEqual({ authenticated: true });
    expect(response.status).toBe(200);
    expect(cookie).toContain("focowiki_admin_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const sessionToken = cookie.match(/focowiki_admin_session=([^;]+)/)?.[1] ?? "";
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionToken).not.toContain(".");
    expect(
      Array.from(redisClient.values.keys()).filter((key) =>
        key.includes(":sessions:")
      )
    ).toHaveLength(1);
    expect(Array.from(redisClient.values.keys()).join("\n")).not.toContain(sessionToken);
  });

  it("rejects invalid username, invalid password, and missing credentials", async () => {
    const app = createApiApp({ config, redis: createTestRedisCoordinator() });
    const invalidUsername = await app.request("/admin/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ username: "wrong", password: "admin-secret" })
    });
    const invalidPassword = await app.request("/admin/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ username: "admin", password: "wrong" })
    });
    const missing = await app.request("/admin/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    expect(invalidUsername.status).toBe(401);
    expect(invalidPassword.status).toBe(401);
    expect(missing.status).toBe(401);
  });

  it("protects admin routes with Redis-backed session cookies", async () => {
    const app = createApiApp({ config, redis: createTestRedisCoordinator() });
    const cookie = await loginAndReadSessionCookie(app);
    const valid = await app.request("/admin/api/session", {
      headers: {
        cookie
      }
    });
    const invalid = await app.request("/admin/api/session", {
      headers: {
        cookie: "focowiki_admin_session=bad"
      }
    });
    const missing = await app.request("/admin/api/session");

    await expect(valid.json()).resolves.toEqual({ authenticated: true });
    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(401);
    expect(missing.status).toBe(401);
  });

  it("does not accept admin credentials from URLs", async () => {
    const app = createApiApp({ config, redis: createTestRedisCoordinator() });
    const login = await app.request("/admin/api/login?username=admin&password=admin-secret", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    const session = await app.request("/admin/api/session?password=admin-secret");

    expect(login.status).toBe(400);
    expect(session.status).toBe(401);
  });

  it("clears the Redis-backed session and cookie on logout", async () => {
    const redisClient = new MemoryRedisCommandClient();
    const app = createApiApp({
      config,
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" })
    });
    const cookie = await loginAndReadSessionCookie(app);
    const logout = await app.request("/admin/api/logout", {
      method: "POST",
      headers: withTrustedAdminOrigin({
        cookie
      })
    });
    const session = await app.request("/admin/api/session", {
      headers: {
        cookie
      }
    });

    await expect(logout.json()).resolves.toEqual({ authenticated: false });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(
      Array.from(redisClient.values.keys()).some((key) => key.includes(":sessions:"))
    ).toBe(false);
    expect(session.status).toBe(401);
  });

  it("rejects cookie-authenticated write requests without a trusted origin", async () => {
    const app = createApiApp({ config, redis: createTestRedisCoordinator() });
    const cookie = await loginAndReadSessionCookie(app);
    const logout = await app.request("/admin/api/logout", {
      method: "POST",
      headers: {
        cookie
      }
    });

    await expect(logout.json()).resolves.toEqual({
      error: {
        code: "INVALID_ORIGIN",
        messageKey: "errors.securityRequestRejected"
      }
    });
    expect(logout.status).toBe(403);
  });

  it("records safe audit evidence for failed login attempts", async () => {
    const events: unknown[] = [];
    const app = createApiApp({
      config,
      redis: createTestRedisCoordinator(),
      repositories: {
        knowledgeBases: {
          async listKnowledgeBases() {
            return { items: [], nextCursor: null };
          },
          async createKnowledgeBase() {
            throw new Error("Unused");
          },
          async getKnowledgeBase() {
            return null;
          }
        },
        securityAudit: {
          async createSecurityAuditEvent(event) {
            events.push(event);
          }
        }
      }
    });
    const response = await app.request("/admin/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ username: "admin", password: "wrong" })
    });

    expect(response.status).toBe(401);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "admin_login",
        result: "failure",
        errorCode: "UNAUTHORIZED",
        username: "admin"
      })
    ]);
    expect(JSON.stringify(events)).not.toContain("wrong");
  });

  it("throttles repeated login attempts through Redis-backed counters", async () => {
    const security = resolveSecurityConfig(config);
    const app = createApiApp({
      config: {
        ...config,
        security: {
          ...security,
          rateLimits: {
            ...security.rateLimits,
            adminLogin: {
              max: 1,
              windowSeconds: 60
            }
          }
        }
      },
      redis: createTestRedisCoordinator()
    });
    const first = await app.request("/admin/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ username: "admin", password: "wrong" })
    });
    const second = await app.request("/admin/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ username: "admin", password: "wrong" })
    });

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
  });

  it("does not expose public OpenAPI file routes from the admin API app", async () => {
    const app = createAdminApiApp({ config, redis: createTestRedisCoordinator() });
    const response = await app.request("/index.md", {
      headers: {
        authorization: "Bearer public-secret"
      }
    });

    expect(response.status).toBe(404);
  });
});
