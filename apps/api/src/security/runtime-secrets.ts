import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const DEPLOYMENT_KEY_FILE = "deployment.key";
const RUNTIME_SECRET_DIR = "runtime-secrets";
const WORKSPACE_MARKER = "pnpm-workspace.yaml";

export function loadDeploymentSecret(input?: { directory?: string | undefined }): string {
  const directory = input?.directory ?? resolveDefaultRuntimeSecretDirectory();
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

export function resolveDefaultRuntimeSecretDirectory(startDirectory = process.cwd()): string {
  const workspaceRoot = findWorkspaceRoot(startDirectory);

  if (!workspaceRoot) {
    return join(startDirectory, RUNTIME_SECRET_DIR);
  }

  const directory = join(workspaceRoot, RUNTIME_SECRET_DIR);
  const legacyDirectory = join(startDirectory, RUNTIME_SECRET_DIR);

  migrateLegacyDeploymentKey({ directory, legacyDirectory });

  return directory;
}

export function readLegacyRuntimeSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SETTINGS_ENCRYPTION_SECRET?.trim() || env.ADMIN_SESSION_SECRET?.trim() || null;
}

function findWorkspaceRoot(startDirectory: string): string | null {
  let current = resolve(startDirectory);

  while (true) {
    if (existsSync(join(current, WORKSPACE_MARKER))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function migrateLegacyDeploymentKey(input: {
  directory: string;
  legacyDirectory: string;
}): void {
  const filePath = join(input.directory, DEPLOYMENT_KEY_FILE);
  const legacyFilePath = join(input.legacyDirectory, DEPLOYMENT_KEY_FILE);

  if (filePath === legacyFilePath || existsSync(filePath) || !existsSync(legacyFilePath)) {
    return;
  }

  const legacy = readFileSync(legacyFilePath, "utf8").trim();
  if (!isValidDeploymentSecret(legacy)) {
    return;
  }

  mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(filePath, `${legacy}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isNodeErrorCode(error, "EEXIST")) {
      throw error;
    }
  }
}

function isValidDeploymentSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
