export const DEFAULT_SECRET_FIELD_NAMES = [
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "PUBLIC_OPENAPI_KEY",
  "OPENAPI_KEY",
  "rawKey",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "MODEL_API_KEY"
] as const;

export type AppErrorOptions = {
  status?: number;
  expose?: boolean;
  details?: unknown;
};

export class AppError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly expose: boolean;
  public readonly details?: unknown;

  public constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? 500;
    this.expose = options.expose ?? false;

    if ("details" in options) {
      this.details = options.details;
    }
  }
}

export class ValidationError extends AppError {
  public readonly issues: string[];

  public constructor(code: string, issues: string[], options: AppErrorOptions = {}) {
    super(code, `Invalid input: ${issues.join("; ")}`, {
      ...options,
      details: issues
    });
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export function redactSecrets(
  input: unknown,
  secretFieldNames: readonly string[] = DEFAULT_SECRET_FIELD_NAMES
): string {
  let safe = errorToString(input);

  for (const fieldName of secretFieldNames) {
    const fieldPattern = new RegExp(
      `(${escapeRegExp(fieldName)}\\s*[:=]\\s*)[^\\s,;\\]}]+`,
      "gi"
    );
    safe = safe.replace(fieldPattern, "$1<redacted>");
  }

  return safe
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;}\]]+/gi, "$1<redacted>")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>");
}

function errorToString(input: unknown): string {
  if (input instanceof Error) {
    return input.message;
  }

  if (typeof input === "string") {
    return input;
  }

  return JSON.stringify(input);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
