import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resources } from "../src/i18n/resources";

const appRoot = process.cwd();
const srcRoot = join(appRoot, "src");
const allowedLiteralPatterns = [
  /data-[a-z-]+=/,
  /aria-[a-z-]+=/,
  /className=/,
  /variant=/,
  /size=/,
  /type=/,
  /id=/,
  /=>/
];

describe("admin i18n static coverage", () => {
  it("defines English and Chinese resources", () => {
    expect(Object.keys(resources).sort()).toEqual(["en-US", "zh-CN"]);
  });

  it("keeps user-visible component copy out of TSX files", () => {
    const files = [
      join(srcRoot, "App.tsx"),
      ...collectTsxFiles(join(srcRoot, "pages")),
      ...collectTsxFiles(join(srcRoot, "components")).filter(
        (file) => !file.includes("/components/ui/")
      )
    ];
    const violations = files.flatMap(findHardcodedCopy);

    expect(violations).toEqual([]);
  });
});

function collectTsxFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const entries = readFileSyncDirectory(directory);
  return entries.flatMap((entry) => {
    if (entry.kind === "directory") {
      return collectTsxFiles(entry.path);
    }

    return entry.path.endsWith(".tsx") ? [entry.path] : [];
  });
}

function readFileSyncDirectory(directory: string): Array<{ kind: "directory" | "file"; path: string }> {
  return readdirSync(directory).map((entry) => {
    const path = join(directory, entry);
    return {
      kind: statSync(path).isDirectory() ? "directory" : "file",
      path
    };
  });
}

function findHardcodedCopy(file: string): string[] {
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");

  return lines.flatMap((line, index) => {
    const trimmed = line.trim();

    if (!trimmed || allowedLiteralPatterns.some((pattern) => pattern.test(trimmed))) {
      return [];
    }

    const hasJsxText = />[^<{}`]+</.test(trimmed);
    const hasVisibleAttribute = /(aria-label|placeholder|title)=["'][^"']+["']/.test(trimmed);

    return hasJsxText || hasVisibleAttribute ? [`${file}:${index + 1}`] : [];
  });
}
