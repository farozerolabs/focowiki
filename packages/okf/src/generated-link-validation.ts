import matter from "gray-matter";
import { posix } from "node:path";
import type { OkfBundleFile } from "./bundle-file.js";
import { OKF_RESERVED_MARKDOWN_FILES } from "./conformance-baseline.js";
import type { OkfConformanceIssue, OkfValidationProfile } from "./conformance-types.js";
import { createConformanceIssue } from "./conformance-types.js";

const RESERVED = new Set<string>(OKF_RESERVED_MARKDOWN_FILES);

export function validateStandardMarkdownLinks(
  file: OkfBundleFile,
  profile: OkfValidationProfile
): OkfConformanceIssue[] {
  if (
    (profile === "focowiki_quality" || profile === "focowiki_extension")
    && /\[\[[^\]]+\]\]/u.test(file.content)
  ) {
    return [createConformanceIssue(
      "FOCOWIKI-QUALITY-STANDARD-MARKDOWN-LINKS",
      profile,
      file.path,
      "Markdown body must use standard Markdown links."
    )];
  }
  return [];
}

export function validateBundleNavigation(
  files: OkfBundleFile[],
  profile: OkfValidationProfile
): OkfConformanceIssue[] {
  if (profile !== "focowiki_quality") return [];

  const issues: OkfConformanceIssue[] = [];
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const root = byPath.get("index.md");
  const rootTargets = root
    ? readMarkdownLinks(root.content)
        .map((link) => resolveBundleTarget(root.path, link.href))
        .filter((path): path is string => path !== null)
    : [];
  if (root && byPath.has("_graph/index.md") && !rootTargets.includes("_graph/index.md")) {
    issues.push(createConformanceIssue(
      "FOCOWIKI-QUALITY-NAVIGATION",
      profile,
      root.path,
      "Bundle root must link to the generated file graph."
    ));
  }

  for (const file of files) {
    if (posix.basename(file.path) !== "index.md") continue;
    for (const link of readMarkdownLinks(file.content)) {
      const targetPath = resolveBundleTarget(file.path, link.href);
      if (!targetPath) continue;
      const target = byPath.get(targetPath);
      if (!target) {
        issues.push(createConformanceIssue(
          "FOCOWIKI-QUALITY-NAVIGATION",
          profile,
          file.path,
          `Generated index link target is missing: ${targetPath}`
        ));
        continue;
      }
      if (!targetPath.endsWith(".md") || RESERVED.has(posix.basename(targetPath))) continue;
      const parsed = matter(target.content);
      const title = typeof parsed.data.title === "string" ? parsed.data.title.trim() : "";
      const description = typeof parsed.data.description === "string"
        ? parsed.data.description.trim()
        : "";
      if (title && link.label !== title && !link.label.startsWith(`${title} (`)) {
        issues.push(createConformanceIssue(
          "FOCOWIKI-QUALITY-NAVIGATION",
          profile,
          file.path,
          `Generated index label must use the target concept title: ${targetPath}`
        ));
      }
      if (description && !link.hasDescription) {
        issues.push(createConformanceIssue(
          "FOCOWIKI-QUALITY-NAVIGATION",
          profile,
          file.path,
          `Generated index entry must include the target concept description: ${targetPath}`
        ));
      }
    }
  }
  return issues;
}

export function readMarkdownLinks(content: string): Array<{
  label: string;
  href: string;
  hasDescription: boolean;
}> {
  const links: Array<{ label: string; href: string; hasDescription: boolean }> = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^[-*] \[([^\]]+)\]\(([^)]+)\)(.*)$/u);
    if (!match) continue;
    links.push({
      label: match[1] ?? "",
      href: match[2] ?? "",
      hasDescription: /^\s+-\s+\S/u.test(match[3] ?? "")
    });
  }
  return links;
}

export function resolveBundleTarget(fromPath: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith("#") || href.includes("{")) {
    return null;
  }
  const clean = href.split(/[?#]/u, 1)[0] ?? "";
  if (!clean || clean.endsWith("/")) return null;
  try {
    return decodeURIComponent(clean.startsWith("/")
      ? clean.slice(1)
      : posix.normalize(posix.join(posix.dirname(fromPath), clean)));
  } catch {
    return null;
  }
}
