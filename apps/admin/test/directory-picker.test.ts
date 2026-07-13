import { describe, expect, it } from "vitest";
import { selectDirectoryFiles, type DirectoryPicker } from "../src/lib/directory-picker";
import { fileRelativePath } from "../src/lib/upload-selection";

describe("directory picker", () => {
  it("collects nested files with the selected root directory path", async () => {
    const picker: DirectoryPicker = async () => directory("handbook", [
      directory("en", [file("intro.md", "English")]),
      directory("zh", [file("intro.md", "Chinese")]),
      file("README.md", "Root")
    ]);

    const result = await selectDirectoryFiles(picker);

    expect(result.status).toBe("selected");
    if (result.status !== "selected") return;
    expect(result.files.map(fileRelativePath)).toEqual([
      "handbook/README.md",
      "handbook/en/intro.md",
      "handbook/zh/intro.md"
    ]);
  });

  it("returns cancelled when the user closes the directory picker", async () => {
    const picker: DirectoryPicker = async () => {
      throw new DOMException("Cancelled", "AbortError");
    };

    await expect(selectDirectoryFiles(picker)).resolves.toEqual({ status: "cancelled" });
  });

  it("returns unsupported when the browser has no directory picker", async () => {
    await expect(selectDirectoryFiles(null)).resolves.toEqual({ status: "unsupported" });
  });
});

type Entry = TestDirectory | TestFile;

type TestDirectory = {
  kind: "directory";
  name: string;
  values: () => AsyncGenerator<Entry>;
};

type TestFile = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
};

function directory(name: string, entries: Entry[]): TestDirectory {
  return {
    kind: "directory" as const,
    name,
    async *values() {
      for (const entry of entries) {
        yield entry;
      }
    }
  };
}

function file(name: string, content: string): TestFile {
  return {
    kind: "file" as const,
    name,
    async getFile() {
      return new File([content], name, { type: "text/markdown" });
    }
  };
}
