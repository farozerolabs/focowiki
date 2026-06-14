import type { Hono } from "hono";
import {
  createRedisCoordinator,
  type RedisCommandClient,
  type RedisCoordinator
} from "../../src/redis/coordination.js";

export class MemoryRedisCommandClient implements RedisCommandClient {
  public readonly values = new Map<string, string>();

  public async set(
    key: string,
    value: string,
    _options?: Record<string, unknown>
  ): Promise<string | null> {
    this.values.set(key, value);
    return "OK";
  }

  public async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  public async del(key: string): Promise<number> {
    const existed = this.values.delete(key);
    return existed ? 1 : 0;
  }
}

export function createTestRedisCoordinator(): RedisCoordinator {
  return createRedisCoordinator(new MemoryRedisCommandClient(), {
    keyPrefix: "focowiki-test"
  });
}

export async function loginAndReadSessionCookie(
  app: Hono,
  credentials: { username?: string; password?: string } = {
    username: "admin",
    password: "admin-secret"
  }
): Promise<string> {
  const response = await app.request("/admin/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(credentials)
  });
  const cookie = response.headers.get("set-cookie");

  if (response.status !== 200 || !cookie) {
    throw new Error("Login did not create a session cookie");
  }

  return cookie.split(";")[0] ?? cookie;
}
