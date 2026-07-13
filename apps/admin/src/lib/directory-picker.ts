import { setFileRelativePath } from "@/lib/upload-selection";

type DirectoryPickerOptions = {
  id: string;
  mode: "read";
};

type PickedFileHandle = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
};

type PickedDirectoryHandle = {
  kind: "directory";
  name: string;
  values: () => AsyncIterable<PickedFileHandle | PickedDirectoryHandle>;
};

export type DirectoryPicker = (
  options: DirectoryPickerOptions
) => Promise<PickedDirectoryHandle>;

export type DirectorySelectionResult =
  | { status: "selected"; files: File[] }
  | { status: "cancelled" }
  | { status: "unsupported" };

export async function selectDirectoryFiles(
  picker: DirectoryPicker | null = browserDirectoryPicker()
): Promise<DirectorySelectionResult> {
  if (!picker) {
    return { status: "unsupported" };
  }

  try {
    const root = await picker({
      id: "focowiki-markdown-sources",
      mode: "read"
    });
    const files: File[] = [];
    await collectDirectoryFiles(root, root.name, files);
    return { status: "selected", files };
  } catch (error) {
    if (isPickerCancellation(error)) {
      return { status: "cancelled" };
    }
    throw error;
  }
}

async function collectDirectoryFiles(
  directory: PickedDirectoryHandle,
  parentPath: string,
  files: File[]
): Promise<void> {
  const entries: Array<PickedFileHandle | PickedDirectoryHandle> = [];
  for await (const entry of directory.values()) {
    entries.push(entry);
  }
  entries.sort((left, right) => compareNames(left.name, right.name));

  for (const entry of entries) {
    const relativePath = `${parentPath}/${entry.name}`;
    if (entry.kind === "directory") {
      await collectDirectoryFiles(entry, relativePath, files);
      continue;
    }
    files.push(setFileRelativePath(await entry.getFile(), relativePath));
  }
}

function browserDirectoryPicker(): DirectoryPicker | null {
  const candidate = (window as unknown as { showDirectoryPicker?: DirectoryPicker })
    .showDirectoryPicker;
  return candidate ? candidate.bind(window) : null;
}

function isPickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
