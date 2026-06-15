export const VISIBLE_UPLOAD_FILE_LIMIT = 8;

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
  return files.some((file) => !file.name.toLowerCase().endsWith(".md"));
}

export function hasDuplicateFileName(files: File[]): boolean {
  const seen = new Set<string>();

  for (const file of files) {
    const normalizedName = normalizeFileName(file.name);

    if (seen.has(normalizedName)) {
      return true;
    }

    seen.add(normalizedName);
  }

  return false;
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

function normalizeFileName(fileName: string): string {
  return fileName.trim().toLowerCase();
}
