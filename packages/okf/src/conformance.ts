import matter from "gray-matter";
import type { OkfBundleFile } from "./generator.js";

const RESERVED_MARKDOWN_FILES = new Set(["index.md", "log.md"]);

export class OkfConformanceError extends Error {
  public readonly issues: string[];

  public constructor(issues: string[]) {
    super(`OKF conformance failed: ${issues.join("; ")}`);
    this.name = "OkfConformanceError";
    this.issues = issues;
  }
}

export function validateOkfBundle(files: OkfBundleFile[]): void {
  const issues = files.flatMap(validateBundleFile);

  if (issues.length > 0) {
    throw new OkfConformanceError(issues);
  }
}

function validateBundleFile(file: OkfBundleFile): string[] {
  if (!file.path.endsWith(".md")) {
    return [];
  }

  const issues: string[] = [];

  if (containsWikiLink(file.content)) {
    issues.push(`${file.path} must use standard Markdown links`);
  }

  if (RESERVED_MARKDOWN_FILES.has(file.path)) {
    return issues;
  }

  try {
    const parsed = matter(file.content);
    const type = typeof parsed.data.type === "string" ? parsed.data.type.trim() : "";
    const title = typeof parsed.data.title === "string" ? parsed.data.title.trim() : "";

    if (!type) {
      issues.push(`${file.path} frontmatter type is required`);
    }

    if (!title) {
      issues.push(`${file.path} frontmatter title is required`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid YAML";
    issues.push(`${file.path} frontmatter is invalid: ${message}`);
  }

  return issues;
}

function containsWikiLink(markdown: string): boolean {
  return /\[\[[^\]]+\]\]/.test(markdown);
}
