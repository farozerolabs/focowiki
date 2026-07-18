import type { Hono } from "hono";
import {
  createRedisCoordinator,
  type RedisCommandClient,
  type RedisCoordinator
} from "../../src/redis/coordination.js";

export const TRUSTED_ADMIN_ORIGIN = "http://localhost:43100";

export function withTrustedAdminOrigin(headers: Record<string, string> = {}): Record<string, string> {
  return {
    origin: TRUSTED_ADMIN_ORIGIN,
    ...headers
  };
}

export class MemoryRedisCommandClient implements RedisCommandClient {
  public readonly values = new Map<string, string>();
  public readonly sets = new Map<string, Set<string>>();
  public readonly expirations = new Map<string, number>();

  public async set(
    key: string,
    value: string,
    options?: Record<string, unknown>
  ): Promise<string | null> {
    if (options?.NX === true && this.values.has(key)) {
      return null;
    }

    this.values.set(key, value);
    return "OK";
  }

  public async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  public async del(key: string): Promise<number> {
    const valueExisted = this.values.delete(key);
    const setExisted = this.sets.delete(key);
    this.expirations.delete(key);
    return valueExisted || setExisted ? 1 : 0;
  }

  public async incr(key: string): Promise<number> {
    const current = this.values.get(key) ?? "0";
    const parsed = Number(current);

    if (!Number.isInteger(parsed)) {
      throw new Error("ERR value is not an integer or out of range");
    }

    const next = parsed + 1;
    this.values.set(key, String(next));
    return next;
  }

  public async expire(key: string, seconds: number): Promise<number> {
    if (!this.values.has(key) && !this.sets.has(key)) {
      return 0;
    }

    this.expirations.set(key, Date.now() + seconds * 1_000);
    return 1;
  }

  public async ttl(key: string): Promise<number> {
    const expiresAt = this.expirations.get(key);

    if (!this.values.has(key) && !this.sets.has(key)) {
      return -2;
    }

    if (!expiresAt) {
      return -1;
    }

    return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1_000));
  }

  public async sAdd(key: string, member: string | string[]): Promise<number> {
    const values = Array.isArray(member) ? member : [member];
    const members = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const value of values) {
      if (!members.has(value)) added += 1;
      members.add(value);
    }
    this.sets.set(key, members);
    return added;
  }

  public async sRem(key: string, member: string | string[]): Promise<number> {
    const values = Array.isArray(member) ? member : [member];
    const members = this.sets.get(key);
    if (!members) return 0;
    let removed = 0;
    for (const value of values) {
      if (members.delete(value)) removed += 1;
    }
    return removed;
  }

  public async *sScanIterator(key: string): AsyncIterable<string[]> {
    const members = [...(this.sets.get(key) ?? [])];
    if (members.length > 0) yield members;
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
