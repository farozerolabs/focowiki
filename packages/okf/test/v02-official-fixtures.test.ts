import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeOkfMetadata,
  inspectOkfBundleProfile,
  OKF_CONFORMANCE_BASELINE,
  OKF_V02_REFERENCE_DIFFERENCES,
  parseUploadedMarkdownSource
} from "../src/index.js";

const checkout = process.env.OKF_V02_OFFICIAL_CHECKOUT_DIR;

describe.runIf(Boolean(checkout))("pinned official OKF 0.2 fixtures", () => {
  it("audits all 78 Markdown files directly from the verified checkout", () => {
    const root = checkout!;
    expect(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim()).toBe(OKF_CONFORMANCE_BASELINE.repositoryRevision);
    const bundlesRoot = join(root, "okf", "bundles");
    const markdownPaths = walkMarkdown(bundlesRoot);
    const reserved = markdownPaths.filter((path) => {
      const name = basename(path);
      return name === "index.md" || name === "log.md";
    });
    expect(markdownPaths).toHaveLength(78);
    expect(reserved).toHaveLength(25);
    expect(markdownPaths.length - reserved.length).toBe(53);
    for (const path of markdownPaths.filter((path) => !reserved.includes(path))) {
      const parsed = parseUploadedMarkdownSource({
        fileName: basename(path),
        content: readFileSync(path, "utf8")
      });
      const analysis = analyzeOkfMetadata(parsed.metadata, {
        ownership: "source",
        markdownBody: parsed.body
      });
      expect(analysis.diagnostics.length).toBeLessThanOrEqual(64);
      expect(analysis.diagnostics.every((diagnostic) =>
        diagnostic.disposition === "advisory")).toBe(true);
    }

    const issues = readdirSync(bundlesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const bundleRoot = join(bundlesRoot, entry.name);
        return inspectOkfBundleProfile(
          walkMarkdown(bundleRoot).map((path) => ({
            path: relative(bundleRoot, path).split("\\").join("/"),
            content: readFileSync(path, "utf8")
          })),
          "normative"
        ).map((issue) => ({ bundle: entry.name, ...issue }));
      });
    expect(issues).toHaveLength(2);
    expect(new Set(issues.map((issue) => issue.ruleId)))
      .toEqual(new Set(["OKF-0.2-LOG-STRUCTURE"]));
    expect(issues.every((issue) =>
      issue.bundle === "acme_retail" && issue.path === "log.md")).toBe(true);
    expect(OKF_V02_REFERENCE_DIFFERENCES).toContainEqual(expect.objectContaining({
      path: "okf/bundles/acme_retail/log.md",
      ruleId: "OKF-0.2-LOG-STRUCTURE"
    }));
  });
});

function walkMarkdown(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? walkMarkdown(path)
        : entry.isFile() && entry.name.endsWith(".md")
          ? [path]
          : [];
    })
    .sort((left, right) => left.localeCompare(right, "en"));
}
