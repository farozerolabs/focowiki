import matter from "gray-matter";
import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SourceMetadataRecord = {
  type?: string;
  title?: string;
  description?: string;
  tags?: string[];
  resource?: string;
  timestamp?: string;
  [key: string]: JsonValue | undefined;
};

export type SourceMetadata = SourceMetadataRecord & {
  type: string;
  title: string;
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

const metadataRecordSchema = z
  .object({
    type: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    resource: z.string().optional(),
    timestamp: z.string().optional()
  })
  .catchall(jsonValueSchema);

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

  const type = typeof metadata.type === "string" ? metadata.type.trim() : "";
  const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
  const resolvedType = type || cleanSuggestedString(source.suggestions?.type) || "document";
  const resolvedTitle =
    title ||
    findFirstHeading(parsed.content) ||
    fileNameStem(source.fileName) ||
    cleanSuggestedString(source.suggestions?.title) ||
    "Untitled";
  const description =
    cleanMetadataString(metadata.description) || cleanSuggestedString(source.suggestions?.description);
  const tags = readResolvedTags(metadata.tags, source.suggestions?.tags);

  return {
    fileName: source.fileName,
    body: parsed.content.trim(),
    metadata: removeUndefinedValues({
      ...metadata,
      type: resolvedType,
      title: resolvedTitle,
      ...(description ? { description } : {}),
      ...(tags.length > 0 ? { tags } : {})
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
    return matter(content);
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

function cleanMetadataString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanSuggestedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
    ? value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
    : [];
}

function findFirstHeading(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function fileNameStem(fileName: string): string {
  const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
  return baseName.replace(/\.md$/i, "").trim();
}

function removeUndefinedValues<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Exclude<unknown, undefined>] => {
      const [, entryValue] = entry;
      return entryValue !== undefined;
    })
  ) as T;
}
