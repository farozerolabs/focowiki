import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RuntimeConfig, RuntimeSecurityConfig } from "../config.js";
import type { RedisCoordinator } from "../redis/coordination.js";

export const ADMIN_SESSION_COOKIE_NAME = "focowiki_admin_session";

export type AdminSessionRecord = {
  username: string;
  createdAt: string;
};

export type AdminSessionManager = {
  authenticate: (credentials: { username: string; password: string }) => boolean;
  createSessionCookie: (username: string) => Promise<string>;
  verifyCookieHeader: (cookieHeader: string | undefined) => Promise<boolean>;
  clearSessionFromCookieHeader: (cookieHeader: string | undefined) => Promise<void>;
  createClearedSessionCookie: () => string;
};

export function createAdminSessionManager(
  config: RuntimeConfig["admin"],
  redis: RedisCoordinator,
  sessionConfig: RuntimeSecurityConfig["session"]
): AdminSessionManager {
  return {
    authenticate(credentials) {
      return (
        secureEquals(credentials.username, config.username) &&
        secureEquals(credentials.password, config.password)
      );
    },
    async createSessionCookie(username) {
      const sessionToken = createSessionToken();
      const sessionTokenHash = hashSessionToken(sessionToken);
      await redis.setSession(
        sessionTokenHash,
        {
          username,
          createdAt: new Date().toISOString()
        } satisfies AdminSessionRecord,
        sessionConfig.ttlSeconds
      );

      return serializeSessionCookie(sessionToken, {
        maxAge: sessionConfig.ttlSeconds,
        secure: sessionConfig.cookieSecure,
        sameSite: sessionConfig.cookieSameSite
      });
    },
    async verifyCookieHeader(cookieHeader) {
      const sessionToken = readSessionToken(cookieHeader);

      if (!sessionToken) {
        return false;
      }

      const session = await redis.getSession<AdminSessionRecord>(hashSessionToken(sessionToken));
      return session?.username === config.username;
    },
    async clearSessionFromCookieHeader(cookieHeader) {
      const sessionToken = readSessionToken(cookieHeader);

      if (sessionToken) {
        await redis.clearSession(hashSessionToken(sessionToken));
      }
    },
    createClearedSessionCookie() {
      return serializeSessionCookie("", {
        maxAge: 0,
        secure: sessionConfig.cookieSecure,
        sameSite: sessionConfig.cookieSameSite
      });
    }
  };
}

function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashSessionToken(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("hex");
}

function readSessionToken(cookieHeader: string | undefined): string | null {
  const rawValue = readCookie(cookieHeader, ADMIN_SESSION_COOKIE_NAME);

  if (!rawValue) {
    return null;
  }

  if (!/^[A-Za-z0-9_-]{43}$/.test(rawValue)) {
    return null;
  }

  return rawValue;
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  const cookies = (cookieHeader ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter(Boolean);

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const cookieName = cookie.slice(0, separatorIndex);
    const cookieValue = cookie.slice(separatorIndex + 1);

    if (cookieName === name) {
      return decodeURIComponent(cookieValue);
    }
  }

  return null;
}

function serializeSessionCookie(
  value: string,
  options: {
    maxAge: number;
    secure: boolean;
    sameSite: RuntimeSecurityConfig["session"]["cookieSameSite"];
  }
): string {
  const parts = [
    `${ADMIN_SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${options.sameSite}`,
    `Max-Age=${options.maxAge}`
  ];

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function secureEquals(value: string, expected: string): boolean {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);

  if (valueBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(valueBuffer, expectedBuffer);
}
