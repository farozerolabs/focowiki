import type {
  BundleFileKind,
  BundleFileRecord
} from "../db/admin-repositories.js";

export type GeneratedFileSearchScope = "all" | "path" | "metadata";

export type GeneratedFileSearchDocumentDraft = {
  knowledgeBaseId: string;
  releaseId: string;
  bundleFileId: string;
  sourceFileId: string | null;
  fileKind: BundleFileKind;
  logicalPath: string;
  title: string | null;
  description: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
  metadataText: string;
  searchText: string;
};

const MAX_TEXT_FIELD_LENGTH = 4_000;
const MAX_ARRAY_VALUES = 40;

const BLOCKED_FRONTMATTER_KEYS = new Set([
  "secret",
  "secrets",
  "password",
  "token",
  "apiKey",
  "api_key",
  "accessKey",
  "access_key",
  "secretKey",
  "secret_key",
  "objectKey",
  "object_key",
  "storagePath",
  "storage_path",
  "localPath",
  "local_path",
  "rawPath",
  "raw_path"
]);

export function createGeneratedFileSearchDocument(
  file: BundleFileRecord
): GeneratedFileSearchDocumentDraft {
  const frontmatter = compactSafeFrontmatter(file.frontmatter);
  const metadataText = truncateText(flattenMetadataText(frontmatter));
  const tags = normalizeTags(file.tags);
  const searchText = normalizeSearchText([
    file.logicalPath,
    file.title,
    file.description,
    ...tags,
    metadataText
  ]);

  return {
    knowledgeBaseId: file.knowledgeBaseId,
    releaseId: file.releaseId,
    bundleFileId: file.id,
    sourceFileId: file.sourceFileId,
    fileKind: file.fileKind,
    logicalPath: file.logicalPath,
    title: truncateNullableText(file.title),
    description: truncateNullableText(file.description),
    tags,
    frontmatter,
    metadataText,
    searchText
  };
}

export function normalizeGeneratedFileSearchQuery(value: string): string {
  return normalizeSearchText([value]);
}

function compactSafeFrontmatter(value: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(value).filter(([key]) => !BLOCKED_FRONTMATTER_KEYS.has(key));
  const compacted: Record<string, unknown> = {};

  for (const [key, rawValue] of entries) {
    const safeValue = readSafeMetadataValue(rawValue);

    if (safeValue !== undefined) {
      compacted[key] = safeValue;
    }
  }

  return compacted;
}

function readSafeMetadataValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateText(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_VALUES)
      .map(readSafeMetadataValue)
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === "object") {
    const compacted: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (BLOCKED_FRONTMATTER_KEYS.has(key)) {
        continue;
      }

      const safeValue = readSafeMetadataValue(child);

      if (safeValue !== undefined) {
        compacted[key] = safeValue;
      }
    }

    return compacted;
  }

  return undefined;
}

function flattenMetadataText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(flattenMetadataText).join(" ");
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => [key, flattenMetadataText(child)])
      .join(" ");
  }

  return "";
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, MAX_ARRAY_VALUES);
}

function normalizeSearchText(values: Array<string | null | undefined>): string {
  return truncateText(
    values
      .map((value) => value?.trim() ?? "")
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase("en-US")
  );
}

function truncateNullableText(value: string | null): string | null {
  return value ? truncateText(value) : null;
}

function truncateText(value: string): string {
  return value.slice(0, MAX_TEXT_FIELD_LENGTH);
}
