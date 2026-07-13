import { describe, expect, it } from "vitest";
import {
  SourcePathValidationError,
  generatedPagePath,
  normalizeGeneratedLogicalPath,
  normalizeSourceDirectoryPath,
  normalizeSourceRelativePath
} from "../src/domain/source-path.js";

describe("source path policy", () => {
  it("preserves safe nested Unicode paths and creates a portable key", () => {
    const path = normalizeSourceRelativePath("资料/产品/安装指南.md");

    expect(path).toEqual({
      relativePath: "资料/产品/安装指南.md",
      pathKey: "资料/产品/安装指南.md",
      name: "安装指南.md",
      directoryPath: "资料/产品",
      depth: 2,
      generatedPath: "pages/资料/产品/安装指南.md"
    });
  });

  it("normalizes composed Unicode and case for uniqueness", () => {
    expect(normalizeSourceRelativePath("Root/Cafe\u0301.MD").pathKey).toBe("root/café.md");
  });

  it("normalizes a user directory without treating it as a Markdown source", () => {
    expect(normalizeSourceDirectoryPath("Manuals/Setup")).toEqual({
      relativePath: "Manuals/Setup",
      pathKey: "manuals/setup",
      name: "Setup",
      parentPath: "Manuals",
      depth: 2,
      generatedPath: "pages/Manuals/Setup"
    });
  });

  it.each(["", "/root", "root/../secret", "root\\secret", "root/file.md"])(
    "rejects unsafe source directory path %s",
    (input) => {
      expect(() => normalizeSourceDirectoryPath(input)).toThrow(SourcePathValidationError);
    }
  );

  it.each([
    "",
    " root/file.md",
    "/root/file.md",
    "C:/root/file.md",
    "root//file.md",
    "root/./file.md",
    "root/../file.md",
    "root\\file.md",
    "root/%2e%2e/file.md",
    "root/%252e%252e/file.md",
    "root/%2fetc/file.md",
    "root/file.txt",
    "root/index.md",
    "root/index-map-000001.md",
    "root/INDEX-000001.md",
    "root/log-1.md"
  ])("rejects unsafe or generated-reserved source path %s", (input) => {
    expect(() => normalizeSourceRelativePath(input)).toThrow(SourcePathValidationError);
  });

  it("allows equal basenames at different relative paths", () => {
    const left = normalizeSourceRelativePath("department-a/guide.md");
    const right = normalizeSourceRelativePath("department-b/guide.md");

    expect(left.name).toBe(right.name);
    expect(left.pathKey).not.toBe(right.pathKey);
  });

  it("maps source paths to canonical generated paths", () => {
    expect(generatedPagePath("manual/setup.md")).toBe("pages/manual/setup.md");
  });

  it.each([
    "index.md",
    "log.md",
    "log-000001.md",
    "schema.md",
    "pages/root/section/page.md",
    "pages/资料/页面.md",
    "_index/manifest.json",
    "_graph/by-file/source-file-1.json"
  ])("accepts safe generated logical path %s", (input) => {
    expect(normalizeGeneratedLogicalPath(input)).toBe(input);
  });

  it.each([
    "pages/../secret.md",
    "pages/%2e%2e/secret.md",
    "pages/root/%252e%252e/secret.md",
    "pages/root\\secret.md",
    "unknown/file.md"
  ])("rejects unsafe generated logical path %s", (input) => {
    expect(() => normalizeGeneratedLogicalPath(input)).toThrow(SourcePathValidationError);
  });
});
