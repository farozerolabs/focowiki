import matter from "gray-matter";
import type { OkfBundleFile } from "./bundle-file.js";
import type { OkfConformanceIssue, OkfValidationProfile } from "./conformance-types.js";
import { createConformanceIssue } from "./conformance-types.js";

const NUMBERED_NAVIGATION_FILE = /^(?:index|index-map|log)-\d{6}\.md$/u;

export function validateConceptFile(
  file: OkfBundleFile,
  profile: OkfValidationProfile
): OkfConformanceIssue[] {
  const issues: OkfConformanceIssue[] = [];
  const parsed = parseConformanceFrontmatter({ file, profile, issues, required: true });
  if (!parsed) return issues;

  const type = readString(parsed.data.type);
  if (!type) {
    issues.push(createConformanceIssue(
      "OKF-0.1-CONCEPT-TYPE",
      profile,
      file.path,
      "Concept frontmatter must contain a non-empty type field."
    ));
  }

  const title = readString(parsed.data.title);
  const description = readString(parsed.data.description);
  if (profile === "recommended" && !title) {
    issues.push(createConformanceIssue(
      "OKF-0.1-RECOMMENDED-TITLE",
      profile,
      file.path,
      "Concept frontmatter should contain a display title."
    ));
  }
  if (
    profile === "recommended"
    && description
    && title
    && normalizeComparable(description) === normalizeComparable(title)
  ) {
    issues.push(createConformanceIssue(
      "OKF-0.1-RECOMMENDED-DESCRIPTION",
      profile,
      file.path,
      "Concept description should add information beyond its title."
    ));
  }
  if (profile === "focowiki_quality" && !title) {
    issues.push(createConformanceIssue(
      "FOCOWIKI-QUALITY-TITLE",
      profile,
      file.path,
      "Generated concept frontmatter must contain a display title."
    ));
  }

  const basename = file.path.split("/").at(-1) ?? "";
  if (
    profile === "focowiki_extension"
    && NUMBERED_NAVIGATION_FILE.test(basename)
    && parsed.data.navigation_only !== true
  ) {
    issues.push(createConformanceIssue(
      "FOCOWIKI-EXTENSION-NAVIGATION",
      profile,
      file.path,
      "Numbered navigation concepts must declare navigation_only: true."
    ));
  }

  return issues;
}

export function parseConformanceFrontmatter(input: {
  file: OkfBundleFile;
  profile: OkfValidationProfile;
  issues: OkfConformanceIssue[];
  required: boolean;
}): ReturnType<typeof matter> | null {
  try {
    const parsed = matter(input.file.content);
    if (input.required && !input.file.content.startsWith("---")) {
      input.issues.push(createConformanceIssue(
        "OKF-0.1-CONCEPT-FRONTMATTER",
        input.profile,
        input.file.path,
        "Concept document must begin with parseable YAML frontmatter."
      ));
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid YAML";
    input.issues.push(createConformanceIssue(
      "OKF-0.1-CONCEPT-FRONTMATTER",
      input.profile,
      input.file.path,
      `Markdown frontmatter is invalid: ${message}`
    ));
    return null;
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeComparable(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[.!?;:。！？；：]+$/u, "")
    .trim()
    .toLocaleLowerCase();
}
