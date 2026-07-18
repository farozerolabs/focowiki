const MAX_PATH_LENGTH = 2_048;
const MAX_SEGMENT_LENGTH = 240;
const MARKDOWN_EXTENSION = ".md";
const GENERATED_ROOT_FILES = new Set(["index.md", "log.md", "schema.md"]);
const GENERATED_DIRECTORY_ROOTS = new Set(["pages", "_index", "_graph"]);
const RESERVED_SOURCE_NAME = /^(?:index(?:-map)?|log)(?:-\d+)?\.md$/iu;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DRIVE_PREFIX = /^[a-z]:[\\/]/iu;

export type SourceRelativePath = {
  relativePath: string;
  pathKey: string;
  name: string;
  directoryPath: string;
  depth: number;
  generatedPath: string;
};

export type SourceDirectoryPath = {
  relativePath: string;
  pathKey: string;
  name: string;
  parentPath: string;
  depth: number;
  generatedPath: string;
};

export type SourcePathValidationCode =
  | "empty"
  | "whitespace"
  | "absolute"
  | "length"
  | "segment"
  | "traversal"
  | "separator"
  | "control_character"
  | "extension"
  | "reserved"
  | "generated_root";

export class SourcePathValidationError extends Error {
  public readonly code: SourcePathValidationCode;
  public readonly path: string;

  public constructor(code: SourcePathValidationCode, path: string) {
    super(`Invalid source path (${code}).`);
    this.name = "SourcePathValidationError";
    this.code = code;
    this.path = path;
  }
}

export function normalizeSourceRelativePath(input: string): SourceRelativePath {
  const relativePath = normalizePath(input);
  const segments = relativePath.split("/");
  const name = segments.at(-1) ?? "";

  if (!name.toLocaleLowerCase("en-US").endsWith(MARKDOWN_EXTENSION)) {
    throw new SourcePathValidationError("extension", input);
  }

  if (RESERVED_SOURCE_NAME.test(name)) {
    throw new SourcePathValidationError("reserved", input);
  }

  const directorySegments = segments.slice(0, -1);
  return {
    relativePath,
    pathKey: relativePath.toLocaleLowerCase("en-US"),
    name,
    directoryPath: directorySegments.join("/"),
    depth: directorySegments.length,
    generatedPath: `pages/${relativePath}`
  };
}

export function normalizeSourceDirectoryPath(input: string): SourceDirectoryPath {
  const relativePath = normalizePath(input);
  const segments = relativePath.split("/");
  const name = segments.at(-1) ?? "";

  if (name.toLocaleLowerCase("en-US").endsWith(MARKDOWN_EXTENSION)) {
    throw new SourcePathValidationError("extension", input);
  }

  return {
    relativePath,
    pathKey: relativePath.toLocaleLowerCase("en-US"),
    name,
    parentPath: segments.slice(0, -1).join("/"),
    depth: segments.length,
    generatedPath: `pages/${relativePath}`
  };
}

export function generatedPagePath(relativePath: string): string {
  return normalizeSourceRelativePath(relativePath).generatedPath;
}

export function normalizeGeneratedLogicalPath(input: string): string {
  const logicalPath = normalizePath(input);
  const segments = logicalPath.split("/");

  if (segments.length === 1) {
    const name = segments[0]?.toLocaleLowerCase("en-US") ?? "";
    if (
      GENERATED_ROOT_FILES.has(name)
      || /^schema-[a-z0-9-]+\.md$/u.test(name)
      || /^log-\d{6}\.md$/u.test(name)
    ) {
      return logicalPath;
    }
    throw new SourcePathValidationError("generated_root", input);
  }

  if (!GENERATED_DIRECTORY_ROOTS.has(segments[0] ?? "")) {
    throw new SourcePathValidationError("generated_root", input);
  }

  return logicalPath;
}

export function sourcePathKey(input: string): string {
  return normalizeSourceRelativePath(input).pathKey;
}

function normalizePath(input: string): string {
  if (!input) {
    throw new SourcePathValidationError("empty", input);
  }
  if (input !== input.trim()) {
    throw new SourcePathValidationError("whitespace", input);
  }
  if (input.startsWith("/") || WINDOWS_DRIVE_PREFIX.test(input)) {
    throw new SourcePathValidationError("absolute", input);
  }
  if (input.includes("\\")) {
    throw new SourcePathValidationError("separator", input);
  }
  if (CONTROL_CHARACTERS.test(input)) {
    throw new SourcePathValidationError("control_character", input);
  }

  const normalized = input.normalize("NFC");
  if (normalized.length > MAX_PATH_LENGTH) {
    throw new SourcePathValidationError("length", input);
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    validateSegment(segment, input);
  }
  return normalized;
}

function validateSegment(segment: string, path: string): void {
  if (!segment || segment.length > MAX_SEGMENT_LENGTH) {
    throw new SourcePathValidationError("segment", path);
  }
  if (segment === "." || segment === "..") {
    throw new SourcePathValidationError("traversal", path);
  }
  if (CONTROL_CHARACTERS.test(segment)) {
    throw new SourcePathValidationError("control_character", path);
  }

  let decoded = segment;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = decodeAsciiPercentSequences(decoded);
    if (next === decoded) {
      break;
    }
    decoded = next;
    if (decoded === "." || decoded === "..") {
      throw new SourcePathValidationError("traversal", path);
    }
    if (decoded.includes("/") || decoded.includes("\\")) {
      throw new SourcePathValidationError("separator", path);
    }
    if (CONTROL_CHARACTERS.test(decoded)) {
      throw new SourcePathValidationError("control_character", path);
    }
  }

  if (decodeAsciiPercentSequences(decoded) !== decoded) {
    throw new SourcePathValidationError("segment", path);
  }
}

function decodeAsciiPercentSequences(value: string): string {
  return value.replace(/%([0-7][0-9a-f])/giu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}
