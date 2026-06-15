import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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
      const sessionId = randomUUID();
      await redis.setSession(
        sessionId,
        {
          username,
          createdAt: new Date().toISOString()
        } satisfies AdminSessionRecord,
        sessionConfig.ttlSeconds
      );

      return serializeSessionCookie(signSessionId(sessionId, config.sessionSecret), {
        maxAge: sessionConfig.ttlSeconds,
        secure: sessionConfig.cookieSecure,
        sameSite: sessionConfig.cookieSameSite
      });
    },
    async verifyCookieHeader(cookieHeader) {
      const sessionId = readSignedSessionId(cookieHeader, config.sessionSecret);

      if (!sessionId) {
        return false;
      }

      const session = await redis.getSession<AdminSessionRecord>(sessionId);
      return session?.username === config.username;
    },
    async clearSessionFromCookieHeader(cookieHeader) {
      const sessionId = readSignedSessionId(cookieHeader, config.sessionSecret);

      if (sessionId) {
        await redis.clearSession(sessionId);
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

function signSessionId(sessionId: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(sessionId).digest("base64url");
  return `${sessionId}.${signature}`;
}

function readSignedSessionId(
  cookieHeader: string | undefined,
  secret: string
): string | null {
  const rawValue = readCookie(cookieHeader, ADMIN_SESSION_COOKIE_NAME);

  if (!rawValue) {
    return null;
  }

  const [sessionId, signature] = rawValue.split(".");

  if (!sessionId || !signature) {
    return null;
  }

  const expected = signSessionId(sessionId, secret);
  return secureEquals(rawValue, expected) ? sessionId : null;
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
