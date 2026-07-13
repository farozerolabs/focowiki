import type { OkfBundleFile } from "./bundle-file.js";
import type { OkfConformanceIssue, OkfValidationProfile } from "./conformance-types.js";
import { createConformanceIssue } from "./conformance-types.js";
import { parseConformanceFrontmatter } from "./concept-validation.js";

export function validateReservedFile(
  file: OkfBundleFile,
  basename: "index.md" | "log.md",
  profile: OkfValidationProfile
): OkfConformanceIssue[] {
  const issues: OkfConformanceIssue[] = [];
  const parsed = parseConformanceFrontmatter({ file, profile, issues, required: false });
  if (!parsed) return issues;
  const frontmatterKeys = Object.keys(parsed.data);

  if (basename === "index.md") {
    validateIndex(file, parsed.content, parsed.data, frontmatterKeys, profile, issues);
    return issues;
  }

  validateLog(file, parsed.content, frontmatterKeys, profile, issues);
  return issues;
}

function validateIndex(
  file: OkfBundleFile,
  content: string,
  data: Record<string, unknown>,
  frontmatterKeys: string[],
  profile: OkfValidationProfile,
  issues: OkfConformanceIssue[]
): void {
  if (file.path === "index.md") {
    const invalidKeys = frontmatterKeys.filter((key) => key !== "okf_version");
    if (invalidKeys.length > 0) {
      issues.push(createConformanceIssue(
        "OKF-0.1-INDEX-STRUCTURE",
        profile,
        file.path,
        "Bundle-root index frontmatter may contain only okf_version."
      ));
    }
    if ("okf_version" in data && String(data.okf_version).trim() !== "0.1") {
      issues.push(createConformanceIssue(
        "OKF-0.1-INDEX-STRUCTURE",
        profile,
        file.path,
        "Bundle-root index declares an unsupported okf_version."
      ));
    }
  } else if (frontmatterKeys.length > 0) {
    issues.push(createConformanceIssue(
      "OKF-0.1-INDEX-STRUCTURE",
      profile,
      file.path,
      "Nested index files must not contain frontmatter."
    ));
  }
  if (!/^#\s+\S+/mu.test(content)) {
    issues.push(createConformanceIssue(
      "OKF-0.1-INDEX-STRUCTURE",
      profile,
      file.path,
      "Index file must contain a Markdown section heading."
    ));
  }
}

function validateLog(
  file: OkfBundleFile,
  content: string,
  frontmatterKeys: string[],
  profile: OkfValidationProfile,
  issues: OkfConformanceIssue[]
): void {
  if (frontmatterKeys.length > 0) {
    issues.push(createConformanceIssue(
      "OKF-0.1-LOG-STRUCTURE",
      profile,
      file.path,
      "Log files must not contain frontmatter."
    ));
  }
  if (!/^# Directory Update Log\s*$/mu.test(content)) {
    issues.push(createConformanceIssue(
      "OKF-0.1-LOG-STRUCTURE",
      profile,
      file.path,
      "Log files must begin with # Directory Update Log."
    ));
  }
  const dateHeadings = content
    .split("\n")
    .filter((line) => /^##\s+/u.test(line));
  if (dateHeadings.some((line) => !/^##\s+\d{4}-\d{2}-\d{2}\s*$/u.test(line))) {
    issues.push(createConformanceIssue(
      "OKF-0.1-LOG-STRUCTURE",
      profile,
      file.path,
      "Log date headings must use YYYY-MM-DD."
    ));
  }
  const dates = dateHeadings
    .map((line) => line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/u)?.[1] ?? null)
    .filter((date): date is string => date !== null);
  if (dates.some((date, index) => index > 0 && date > dates[index - 1]!)) {
    issues.push(createConformanceIssue(
      "OKF-0.1-LOG-STRUCTURE",
      profile,
      file.path,
      "Log date headings must be ordered newest first."
    ));
  }
}
