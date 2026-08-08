import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  canonicalizeGeneratedTextIdentity,
  canonicalizeOptionalGeneratedTextIdentity
} from "./text-identity.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const MAXIMUM_SOURCE_METADATA_BYTES = 8_192;

export function measureSourceMetadataBytes(metadata: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(metadata), "utf8");
}

export type SourceMetadataRecord = {
  [key: string]: JsonValue | undefined;
};

export type SourceMetadata = SourceMetadataRecord & {
  type: string;
  title: string;
  description?: string;
  tags?: string[];
  resource?: string;
  timestamp?: string;
};

export type SourceMetadataDefaults = SourceMetadataRecord;

export type SourceMetadataSuggestions = {
  title?: string;
  type?: string;
  description?: string;
  tags?: string[];
  related_links?: Array<{
    path: string;
    title: string;
  }>;
  keywords?: string[];
};

export type UploadedMarkdownSource = {
  fileName: string;
  content: string;
  metadata?: SourceMetadataDefaults;
  defaults?: SourceMetadataDefaults;
  suggestions?: SourceMetadataSuggestions | null;
};

export type ParsedUploadedMarkdownSource = {
  fileName: string;
  body: string;
  metadata: SourceMetadataDefaults;
};

export type ResolvedSourceMetadata = {
  fileName: string;
  body: string;
  metadata: SourceMetadata;
};

export class MetadataValidationError extends Error {
  public readonly issues: string[];

  public constructor(issues: string[]) {
    super(`Invalid source metadata: ${issues.join("; ")}`);
    this.name = "MetadataValidationError";
    this.issues = issues;
  }
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

const metadataRecordSchema = z.record(z.string(), jsonValueSchema);

export function parseUploadedMarkdownSource(input: {
  fileName: string;
  content: string;
}): ParsedUploadedMarkdownSource {
  assertMarkdownFile(input.fileName);
  const parsed = parseMarkdown(input.content);

  return {
    fileName: input.fileName,
    body: parsed.content.trim(),
    metadata: parseMetadataRecord(parsed.data, "frontmatter")
  };
}

export function resolveSourceMetadata(source: UploadedMarkdownSource): ResolvedSourceMetadata {
  assertMarkdownFile(source.fileName);
  const parsed = parseMarkdown(source.content);
  const frontmatter = parseMetadataRecord(parsed.data, "frontmatter");
  const defaults = parseMetadataRecord(source.defaults ?? {}, "defaults");
  const metadataInput = parseMetadataRecord(source.metadata ?? {}, "metadata");
  const metadata = removeUndefinedValues(
    metadataRecordSchema.parse({
      ...defaults,
      ...frontmatter,
      ...metadataInput
    })
  ) as SourceMetadataDefaults;

  let resolvedType: string;
  let resolvedTitle: string;
  let description: string | null;
  let tags: string[];
  let timestamp: string | null;
  let version: string | null;
  const type = safeOptionalIdentity(metadata.type, "type");
  const title = safeOptionalIdentity(metadata.title, "title");
  resolvedType = canonicalizeGeneratedTextIdentity(
    type ?? cleanSuggestedString(source.suggestions?.type) ?? "document",
    "type"
  );
  resolvedTitle = canonicalizeGeneratedTextIdentity(
    title
      ?? safeOptionalIdentity(findFirstHeading(parsed.content), "heading")
      ?? safeOptionalIdentity(fileNameStem(source.fileName), "file name")
      ?? cleanSuggestedString(source.suggestions?.title)
      ?? "Untitled",
    "title"
  );
  description = safeOptionalIdentity(metadata.description, "description")
    ?? safeOptionalIdentity(source.suggestions?.description, "suggested description");
  tags = readResolvedTags(metadata.tags, source.suggestions?.tags);
  timestamp = safeOptionalIdentity(metadata.timestamp, "timestamp");
  version = safeOptionalIdentity(metadata.version, "version");

  const {
    type: _type,
    title: _title,
    description: _description,
    tags: _tags,
    timestamp: _timestamp,
    version: _version,
    ...customMetadata
  } = metadata;

  return {
    fileName: source.fileName,
    body: parsed.content.trim(),
    metadata: removeUndefinedValues({
      ...customMetadata,
      type: resolvedType,
      title: resolvedTitle,
      ...(description ? { description } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(timestamp ? { timestamp } : {}),
      ...(version ? { version } : {})
    }) as SourceMetadata
  };
}

function assertMarkdownFile(fileName: string): void {
  if (!fileName.toLowerCase().endsWith(".md")) {
    throw new MetadataValidationError([
      "Source upload must be a .md file and will not be converted"
    ]);
  }
}

function parseMarkdown(content: string): matter.GrayMatterFile<string> {
  try {
    // gray-matter caches every unique source body when called without options.
    // Source processing parses unbounded user content, so pass explicit options
    // to keep parsing request-scoped while preserving the default syntax.
    return matter(content, {
      engines: {
        yaml: (source) => parseYaml(source, { schema: "core" })
      }
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new MetadataValidationError([`frontmatter is invalid: ${error.message}`]);
    }

    throw new MetadataValidationError(["frontmatter is invalid"]);
  }
}

function parseMetadataRecord(value: unknown, sourceName: string): SourceMetadataDefaults {
  const result = metadataRecordSchema.safeParse(value ?? {});

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${sourceName}.${issue.path.join(".")} ${issue.message}`.trim()
    );
    throw new MetadataValidationError(issues);
  }

  return removeUndefinedValues(result.data) as SourceMetadataDefaults;
}

function cleanSuggestedString(value: unknown): string | null {
  return safeOptionalIdentity(value);
}

function safeOptionalIdentity(value: unknown, field: string | null = null): string | null {
  try {
    return canonicalizeOptionalGeneratedTextIdentity(value, field);
  } catch {
    return null;
  }
}

function readResolvedTags(metadataTags: unknown, suggestedTags: unknown): string[] {
  const frontmatterTags = readStringList(metadataTags);

  if (frontmatterTags.length > 0) {
    return frontmatterTags;
  }

  return readStringList(suggestedTags);
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const canonical = safeOptionalIdentity(item, "tag");
        return canonical ? [canonical] : [];
      })
    : [];
}

function findFirstHeading(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);

    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function fileNameStem(fileName: string): string | null {
  const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
  return canonicalizeOptionalGeneratedTextIdentity(baseName.replace(/\.md$/i, ""));
}

function removeUndefinedValues<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Exclude<unknown, undefined>] => {
      const [, entryValue] = entry;
      return entryValue !== undefined;
    })
  ) as T;
}
