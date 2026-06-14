import matter from "gray-matter";
import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SourceMetadata = {
  type: string;
  title: string;
  description?: string;
  tags?: string[];
  resource?: string;
  timestamp?: string;
  [key: string]: JsonValue | undefined;
};

export type SourceMetadataDefaults = Partial<SourceMetadata>;

export type UploadedMarkdownSource = {
  fileName: string;
  content: string;
  defaults: SourceMetadataDefaults;
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

export function resolveSourceMetadata(source: UploadedMarkdownSource): ResolvedSourceMetadata {
  const issues: string[] = [];

  if (!source.fileName.toLowerCase().endsWith(".md")) {
    throw new MetadataValidationError([
      "Source upload must be a .md file and will not be converted"
    ]);
  }

  const parsed = parseMarkdown(source.content);
  const defaults = parseMetadataRecord(source.defaults, "defaults");
  const frontmatter = parseMetadataRecord(parsed.data, "frontmatter");
  const metadata = metadataRecordSchema.parse({
    ...defaults,
    ...frontmatter
  });

  const type = typeof metadata.type === "string" ? metadata.type.trim() : "";
  const title = typeof metadata.title === "string" ? metadata.title.trim() : "";

  if (!type) {
    issues.push("type is required");
  }

  if (!title) {
    issues.push("title is required");
  }

  if (issues.length > 0) {
    throw new MetadataValidationError(issues);
  }

  return {
    fileName: source.fileName,
    body: parsed.content.trim(),
    metadata: removeUndefinedValues({
      ...metadata,
      type,
      title
    }) as SourceMetadata
  };
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

function parseMetadataRecord(value: unknown, sourceName: string): z.infer<typeof metadataRecordSchema> {
  const result = metadataRecordSchema.safeParse(value);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${sourceName}.${issue.path.join(".")} ${issue.message}`.trim()
    );
    throw new MetadataValidationError(issues);
  }

  return removeUndefinedValues(result.data);
}

function removeUndefinedValues<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Exclude<unknown, undefined>] => {
      const [, entryValue] = entry;
      return entryValue !== undefined;
    })
  ) as T;
}
