export const VISIBLE_UPLOAD_FILE_LIMIT = 8;

const selectedRelativePaths = new WeakMap<File, string>();

export function filesFromSelection(files: FileList | null): File[] {
  return files ? Array.from(files) : [];
}

export function removeSelectedFileAt(files: File[], index: number): File[] {
  return files.filter((_file, fileIndex) => fileIndex !== index);
}

export function totalSelectedFileBytes(files: File[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

export function hasUnsupportedMarkdownFile(files: File[]): boolean {
  return files.some((file) => !fileRelativePath(file).toLowerCase().endsWith(".md"));
}

export function hasDuplicateFileName(files: File[]): boolean {
  const seen = new Set<string>();

  for (const file of files) {
    const normalizedName = normalizeUploadRelativePath(fileRelativePath(file));

    if (seen.has(normalizedName)) {
      return true;
    }

    seen.add(normalizedName);
  }

  return false;
}

export function fileRelativePath(file: File): string {
  return selectedRelativePaths.get(file) || file.webkitRelativePath || file.name;
}

export function setFileRelativePath(file: File, relativePath: string): File {
  selectedRelativePaths.set(file, relativePath);
  return file;
}

export function normalizeUploadRelativePath(relativePath: string): string {
  return relativePath.normalize("NFC").toLocaleLowerCase("en-US");
}

export function invalidSelectedUploadPaths(files: File[]): string[] {
  return files
    .map(fileRelativePath)
    .filter((path) => !isSafeMarkdownRelativePath(path));
}

export function visibleSelectedFiles(files: File[]): {
  items: File[];
  hiddenCount: number;
} {
  return {
    items: files.slice(0, VISIBLE_UPLOAD_FILE_LIMIT),
    hiddenCount: Math.max(files.length - VISIBLE_UPLOAD_FILE_LIMIT, 0)
  };
}

export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = 0;
  let value = bytes / 1024;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 ? 1 : 2;
  const formatted = value.toFixed(precision).replace(/\.0+$/, "");

  return `${formatted} ${units[unitIndex]}`;
}

function isSafeMarkdownRelativePath(path: string): boolean {
  if (!path || path !== path.trim() || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  const segments = path.normalize("NFC").split("/");
  const name = segments.at(-1) ?? "";
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.length > 240 ||
        /[\u0000-\u001f\u007f]/u.test(segment)
    ) ||
    path.length > 2_048 ||
    !name.toLocaleLowerCase("en-US").endsWith(".md")
  ) {
    return false;
  }
  return !/^(?:index(?:-map)?|log)(?:-\d+)?\.md$/iu.test(name);
}
