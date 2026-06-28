import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const DEPLOYMENT_KEY_FILE = "deployment.key";

export function loadDeploymentSecret(input?: { directory?: string | undefined }): string {
  const directory = input?.directory ?? join(process.cwd(), "runtime-secrets");
  const filePath = join(directory, DEPLOYMENT_KEY_FILE);

  mkdirSync(directory, { recursive: true, mode: 0o700 });

  try {
    const value = readFileSync(filePath, "utf8").trim();
    if (isValidDeploymentSecret(value)) {
      return value;
    }
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  const generated = randomBytes(32).toString("base64url");

  try {
    writeFileSync(filePath, `${generated}\n`, { flag: "wx", mode: 0o600 });
    void chmod(directory, 0o700).catch(() => undefined);
    return generated;
  } catch (error) {
    if (!isNodeErrorCode(error, "EEXIST")) {
      throw error;
    }
  }

  const existing = readFileSync(filePath, "utf8").trim();
  if (!isValidDeploymentSecret(existing)) {
    throw new Error("Runtime deployment secret is invalid");
  }
  return existing;
}

export function readLegacyRuntimeSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SETTINGS_ENCRYPTION_SECRET?.trim() || env.ADMIN_SESSION_SECRET?.trim() || null;
}

function isValidDeploymentSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
