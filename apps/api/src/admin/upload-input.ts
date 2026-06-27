import type { AdminRepositories } from "../db/admin-repositories.js";
import type { UploadFile } from "./upload-processor-utils.js";

export function hasDuplicateUploadFileNames(files: UploadFile[]): boolean {
  const names = new Set<string>();

  for (const file of files) {
    const name = normalizeSourceFileName(file.name);

    if (names.has(name)) {
      return true;
    }

    names.add(name);
  }

  return false;
}

export function hasUnsafeUploadFileNames(files: UploadFile[]): boolean {
  return files.some((file) => !isSafeUploadFileName(file.name));
}

export async function hasExistingSourceFileName(input: {
  filesRepository: NonNullable<AdminRepositories["files"]>;
  knowledgeBaseId: string;
  fileNames: string[];
  limit: number;
}): Promise<boolean> {
  const names = new Set(input.fileNames.map(normalizeSourceFileName));

  if (input.filesRepository.hasActiveSourceFileNames) {
    return input.filesRepository.hasActiveSourceFileNames({
      knowledgeBaseId: input.knowledgeBaseId,
      normalizedFileNames: [...names]
    });
  }

  let cursor: string | null = null;

  do {
    const page = await input.filesRepository.listSourceFiles({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: input.limit,
      cursor
    });

    if (page.items.some((file) => names.has(normalizeSourceFileName(file.originalName)))) {
      return true;
    }

    cursor = page.nextCursor;
  } while (cursor);

  return false;
}

export function isUploadFile(value: FormDataEntryValue): value is UploadFile & FormDataEntryValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name: unknown }).name === "string" &&
    "arrayBuffer" in value &&
    typeof (value as { arrayBuffer: unknown }).arrayBuffer === "function"
      );
}

function normalizeSourceFileName(fileName: string): string {
  return fileName.normalize("NFC").trim().toLowerCase();
}

function isSafeUploadFileName(fileName: string): boolean {
  const normalized = fileName.normalize("NFC").trim();

  if (!normalized || normalized !== fileName || normalized.length > 240) {
    return false;
  }

  if (!normalized.toLowerCase().endsWith(".md")) {
    return false;
  }

  if (/[\u0000-\u001f\u007f/\\]/u.test(normalized)) {
    return false;
  }

  return !normalized.split(".").some((segment) => segment === "..");
}
