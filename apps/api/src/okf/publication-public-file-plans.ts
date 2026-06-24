import type { CursorPage, CursorPageRequest } from "../runtime/bounded.js";
import type { SourceFileForPublication } from "./publication.js";
import type { PublicationPublicFilePlans } from "./publication-graph-files.js";

export async function collectPublicFilePlans(input: {
  pageSize: number;
  fetchSourcePage: (request: CursorPageRequest) => Promise<CursorPage<SourceFileForPublication>>;
}): Promise<PublicationPublicFilePlans> {
  const publicFileNames = new Set<string>();
  const publicPaths = new Set(["index.md", "log.md", "schema.md"]);
  const bySourceId = new Map<string, { publicFileName: string; pagePath: string }>();
  let cursor: string | null = null;

  do {
    const page = await input.fetchSourcePage({
      cursor,
      limit: input.pageSize
    });

    for (const source of page.items) {
      const publicFileName = uniquePublicMarkdownFileName({
        fileName: normalizePublicMarkdownFileName(source.originalName),
        discriminator: source.id,
        usedNames: publicFileNames
      });

      if (bySourceId.has(source.id)) {
        throw new Error(`Duplicate source file id: ${source.id}`);
      }

      const pagePath = `pages/${publicFileName}`;
      publicFileNames.add(publicFileName);
      publicPaths.add(pagePath);
      bySourceId.set(source.id, { publicFileName, pagePath });
    }

    cursor = page.nextCursor;
  } while (cursor);

  return { bySourceId, publicPaths };
}

function normalizePublicMarkdownFileName(fileName: string): string {
  const normalized = fileName.trim();

  if (!normalized.toLowerCase().endsWith(".md") || !isSafeTreeSegment(normalized)) {
    throw new Error("Source file name must be a safe Markdown file name");
  }

  return normalized;
}

function uniquePublicMarkdownFileName(input: {
  fileName: string;
  discriminator: string;
  usedNames: Set<string>;
}): string {
  if (!input.usedNames.has(input.fileName)) return input.fileName;

  const suffix = safeFileNameSuffix(input.discriminator) || "duplicate";
  const baseName = input.fileName.slice(0, -".md".length);
  let candidate = `${baseName}--${suffix}.md`;
  let counter = 2;

  while (input.usedNames.has(candidate)) {
    candidate = `${baseName}--${suffix}-${counter}.md`;
    counter += 1;
  }

  return candidate;
}

function isSafeTreeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("..") &&
    !segment.includes("\\") &&
    !segment.includes("/") &&
    !/[\u0000-\u001F\u007F]/.test(segment)
  );
}

function safeFileNameSuffix(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}
