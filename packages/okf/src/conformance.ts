import { posix } from "node:path";
import type { OkfBundleFile } from "./bundle-file.js";
import { OKF_RESERVED_MARKDOWN_FILES } from "./conformance-baseline.js";
import { validateConceptFile } from "./concept-validation.js";
import {
  validateBundleNavigation,
  validateStandardMarkdownLinks
} from "./generated-link-validation.js";
import { validateReservedFile } from "./reserved-file-validation.js";
import type { OkfConformanceIssue, OkfValidationProfile } from "./conformance-types.js";

export type { OkfConformanceIssue, OkfValidationProfile } from "./conformance-types.js";

const RESERVED = new Set<string>(OKF_RESERVED_MARKDOWN_FILES);

export class OkfConformanceError extends Error {
  public readonly issues: OkfConformanceIssue[];

  public constructor(issues: OkfConformanceIssue[]) {
    super(`OKF conformance failed: ${issues.map(formatIssue).join("; ")}`);
    this.name = "OkfConformanceError";
    this.issues = issues;
  }
}

export function validateOkfBundle(files: OkfBundleFile[]): void {
  validateOkfBundleProfile(files, "normative");
}

export function validateOkfBundleProfile(
  files: OkfBundleFile[],
  profile: OkfValidationProfile
): void {
  const issues = [
    ...files.flatMap((file) => validateBundleFile(file, profile)),
    ...validateBundleNavigation(files, profile)
  ];
  if (issues.length > 0) {
    throw new OkfConformanceError(issues);
  }
}

function validateBundleFile(
  file: OkfBundleFile,
  profile: OkfValidationProfile
): OkfConformanceIssue[] {
  if (!file.path.endsWith(".md")) return [];
  const standardLinkIssues = validateStandardMarkdownLinks(file, profile);
  const basename = posix.basename(file.path);
  if (RESERVED.has(basename)) {
    return [
      ...standardLinkIssues,
      ...validateReservedFile(file, basename as "index.md" | "log.md", profile)
    ];
  }
  return [...standardLinkIssues, ...validateConceptFile(file, profile)];
}

function formatIssue(value: OkfConformanceIssue): string {
  return `[${value.ruleId}] ${value.path}: ${value.message}`;
}
