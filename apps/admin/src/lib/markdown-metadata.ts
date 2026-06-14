import type { MetadataDefaultsInput } from "@/lib/admin-api";

export type MarkdownMetadataDefaults = MetadataDefaultsInput;

export function emptyMarkdownMetadataDefaults(): MarkdownMetadataDefaults {
  return {
    defaultType: "",
    defaultTitle: "",
    defaultDescription: "",
    defaultTags: ""
  };
}

export function readMarkdownMetadataDefaults(content: string): MarkdownMetadataDefaults {
  const defaults = emptyMarkdownMetadataDefaults();
  const frontmatter = readFrontmatterBlock(content);

  if (!frontmatter) {
    return {
      ...defaults,
      defaultTitle: readFirstHeading(content)
    };
  }

  const values = readYamlLikeFrontmatter(frontmatter);
  const defaultTitle = readFrontmatterScalar(values, "title");

  return {
    defaultType: readFrontmatterScalar(values, "type"),
    defaultTitle: defaultTitle || readFirstHeading(content),
    defaultDescription: readFrontmatterScalar(values, "description"),
    defaultTags: readFrontmatterTags(values)
  };
}

function readFrontmatterBlock(content: string): string | null {
  const normalizedContent = content.replace(/^\uFEFF/, "");
  const lines = normalizedContent.split(/\r?\n/);

  if (lines[0]?.trim() !== "---") {
    return null;
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

  if (closingIndex < 0) {
    return null;
  }

  return lines.slice(1, closingIndex).join("\n");
}

function readYamlLikeFrontmatter(frontmatter: string) {
  const values = new Map<string, string | string[]>();
  const lines = frontmatter.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);

    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2];

    if (key === undefined || rawValue === undefined) {
      continue;
    }

    const normalizedKey = key.toLowerCase();

    if (normalizedKey === "tags" && rawValue.trim() === "") {
      const tags: string[] = [];

      for (let listIndex = index + 1; listIndex < lines.length; listIndex += 1) {
        const listMatch = /^\s*-\s*(.+?)\s*$/.exec(lines[listIndex] ?? "");

        if (!listMatch) {
          break;
        }

        const tag = listMatch[1];

        if (tag === undefined) {
          break;
        }

        tags.push(unquoteYamlScalar(tag));
        index = listIndex;
      }

      values.set(normalizedKey, tags);
      continue;
    }

    values.set(normalizedKey, unquoteYamlScalar(rawValue));
  }

  return values;
}

function readFrontmatterScalar(values: Map<string, string | string[]>, key: string) {
  const value = values.get(key);

  return typeof value === "string" ? value.trim() : "";
}

function readFrontmatterTags(values: Map<string, string | string[]>) {
  const value = values.get("tags");

  if (Array.isArray(value)) {
    return value.map((tag) => tag.trim()).filter(Boolean).join(", ");
  }

  if (typeof value !== "string") {
    return "";
  }

  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return "";
  }

  if (trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) {
    return trimmedValue
      .slice(1, -1)
      .split(",")
      .map(unquoteYamlScalar)
      .filter(Boolean)
      .join(", ");
  }

  return trimmedValue
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .join(", ");
}

function readFirstHeading(content: string) {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+\S/.test(line.trim()));

  return heading ? heading.replace(/^#\s+/, "").trim() : "";
}

function unquoteYamlScalar(value: string) {
  const trimmedValue = value.trim();

  if (
    (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) ||
    (trimmedValue.startsWith("'") && trimmedValue.endsWith("'"))
  ) {
    return trimmedValue.slice(1, -1).trim();
  }

  return trimmedValue;
}
