import type { AdminRepositories } from "../db/admin-repositories.js";
import type { UploadFile } from "./upload-processor.js";

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

export async function hasExistingSourceFileName(input: {
  filesRepository: NonNullable<AdminRepositories["files"]>;
  knowledgeBaseId: string;
  fileNames: string[];
  limit: number;
}): Promise<boolean> {
  const names = new Set(input.fileNames.map(normalizeSourceFileName));
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

export function readMetadataDefaults(formData: FormData): Record<string, string | string[]> {
  const defaults: Record<string, string | string[]> = {};
  const fields = [
    ["type", "defaultType"],
    ["title", "defaultTitle"],
    ["description", "defaultDescription"],
    ["resource", "defaultResource"]
  ] as const;

  for (const [metadataField, formField] of fields) {
    const value = readFormString(formData, formField);

    if (value) {
      defaults[metadataField] = value;
    }
  }

  const tags = readFormString(formData, "defaultTags")
    ?.split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  if (tags && tags.length > 0) {
    defaults.tags = tags;
  }

  return defaults;
}

function normalizeSourceFileName(fileName: string): string {
  return fileName.trim().toLowerCase();
}

function readFormString(formData: FormData, field: string): string | null {
  const value = formData.get(field);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
