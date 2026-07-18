const UNSAFE_CONTROL_PATTERN = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;
const MARKDOWN_LABEL_ESCAPE_PATTERN = /[\\[\]`*_]/gu;
const MARKDOWN_LABEL_UNESCAPE_PATTERN = /\\([\\[\]`*_])/gu;

export type GeneratedTextIdentityErrorCode =
  | "GENERATED_IDENTITY_TYPE_INVALID"
  | "GENERATED_IDENTITY_EMPTY"
  | "GENERATED_IDENTITY_UNSAFE_CONTROL";

export class GeneratedTextIdentityError extends Error {
  public constructor(
    public readonly code: GeneratedTextIdentityErrorCode,
    public readonly field: string | null = null
  ) {
    super(messageForError(code, field));
    this.name = "GeneratedTextIdentityError";
  }
}

export function canonicalizeGeneratedTextIdentity(
  value: unknown,
  field: string | null = null
): string {
  if (typeof value !== "string") {
    throw new GeneratedTextIdentityError("GENERATED_IDENTITY_TYPE_INVALID", field);
  }

  const canonical = normalizeGeneratedTextIdentity(value);
  if (!canonical) {
    throw new GeneratedTextIdentityError("GENERATED_IDENTITY_EMPTY", field);
  }
  if (UNSAFE_CONTROL_PATTERN.test(canonical)) {
    throw new GeneratedTextIdentityError("GENERATED_IDENTITY_UNSAFE_CONTROL", field);
  }
  return canonical;
}

export function canonicalizeOptionalGeneratedTextIdentity(
  value: unknown,
  field: string | null = null
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && !normalizeGeneratedTextIdentity(value)) {
    return null;
  }
  return canonicalizeGeneratedTextIdentity(value, field);
}

export function sameGeneratedTextIdentity(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeGeneratedTextIdentity(left) === canonicalizeGeneratedTextIdentity(right);
  } catch {
    return false;
  }
}

export function renderMarkdownIdentityLabel(value: unknown): string {
  return canonicalizeGeneratedTextIdentity(value).replace(
    MARKDOWN_LABEL_ESCAPE_PATTERN,
    (character) => `\\${character}`
  );
}

export function decodeMarkdownIdentityLabel(value: unknown): string {
  if (typeof value !== "string") {
    throw new GeneratedTextIdentityError("GENERATED_IDENTITY_TYPE_INVALID");
  }
  return canonicalizeGeneratedTextIdentity(
    value.replace(MARKDOWN_LABEL_UNESCAPE_PATTERN, "$1")
  );
}

function normalizeGeneratedTextIdentity(value: string): string {
  return value.normalize("NFC").replace(/\p{White_Space}+/gu, " ").trim();
}

function messageForError(code: GeneratedTextIdentityErrorCode, field: string | null): string {
  const target = field ? ` for ${field}` : "";
  switch (code) {
    case "GENERATED_IDENTITY_TYPE_INVALID":
      return `Generated text identity${target} must be a string.`;
    case "GENERATED_IDENTITY_EMPTY":
      return `Generated text identity${target} must not be empty.`;
    case "GENERATED_IDENTITY_UNSAFE_CONTROL":
      return `Generated text identity${target} contains an unsafe control character.`;
  }
}
