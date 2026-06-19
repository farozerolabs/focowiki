import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { initI18n } from "../src/i18n";
import {
  deleteKnowledgeBaseFile,
  fetchKnowledgeBaseFileDetail,
  fetchKnowledgeBaseFileTree,
  fetchKnowledgeBasePublicUrls,
  listBundleFiles,
  listReleases,
  listSourceFiles,
  loginAdmin,
} from "../src/lib/admin-api";

vi.mock("../src/lib/admin-api", () => ({
  checkAdminSession: vi.fn(async () => false),
  createKnowledgeBase: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  deleteKnowledgeBaseFile: vi.fn(async () => ({
    deleted: true,
    releaseId: "release-delete"
  })),
  fetchKnowledgeBaseFileDetail: vi.fn(async () => ({
    file: {
      id: "file-001",
      sourceFileId: "source-001",
      fileKind: "page",
      logicalPath: "pages/intro.md",
      contentType: "text/markdown",
      title: "Intro",
      deletable: true
    },
    content: "---\ntype: guide\ntitle: Intro\n---\n# Intro\n\n[Generated page](/pages/intro.md)",
    readOnly: true
  })),
  fetchKnowledgeBaseFileTree: vi.fn(async () => ({
    items: [
      {
        id: "tree-001",
        name: "intro.md",
        logicalPath: "pages/intro.md",
        entryType: "file",
        bundleFileId: "file-001",
        sourceFileId: "source-001",
        fileKind: "page",
        deletable: true
      }
    ],
    nextCursor: null
  })),
  fetchKnowledgeBasePublicUrls: vi.fn(async () => ({
    index: "https://kb.example.com/openapi/v1/knowledge-bases/kb-docs/files/content?path=index.md",
    search:
      "https://kb.example.com/openapi/v1/knowledge-bases/kb-docs/files/content?path=_index%2Fsearch.json",
    links:
      "https://kb.example.com/openapi/v1/knowledge-bases/kb-docs/files/content?path=_index%2Flinks.json"
  })),
  fetchResultFile: vi.fn(),
  fetchResultTree: vi.fn(async () => []),
  generateBundle: vi.fn(),
  listKnowledgeBases: vi.fn(async () => ({
    items: [
      {
        id: "kb-docs",
        name: "Developer docs",
        description: "Markdown product knowledge",
        activeReleaseId: "release-001"
      }
    ],
    nextCursor: null
  })),
  listSourceFiles: vi.fn(async () => ({
    items: [
      {
        id: "source-001",
        originalName: "ff8081819c46fdc3019cd19068731f64-intro-e656df554f9e.md",
        processingStatus: "running",
        processingStage: "metadata_resolution",
        processingStartedAt: "2026-06-14T00:00:00.000Z",
        processingEndedAt: null,
        processingErrorCode: null,
        createdAt: "2026-06-14T00:00:00.000Z"
      },
      {
        id: "source-002",
        originalName: "setup.md",
        processingStatus: "queued",
        processingStage: "upload_storage",
        processingStartedAt: "2026-06-14T00:00:01.000Z",
        processingEndedAt: null,
        processingErrorCode: null,
        createdAt: "2026-06-14T00:00:01.000Z"
      }
    ],
    nextCursor: null
  })),
  listBundleFiles: vi.fn(async () => ({
    items: [
      {
        id: "bundle-file-001",
        logicalPath: "pages/intro.md",
        contentType: "text/markdown",
        title: "Intro"
      }
    ],
    nextCursor: null
  })),
  listReleases: vi.fn(async () => ({
    items: [
      {
        id: "release-001",
        fileCount: 7,
        generatedAt: "2026-06-14T00:00:00.000Z",
        publishedAt: "2026-06-14T00:00:01.000Z"
      }
    ],
    nextCursor: null
  })),
  loginAdmin: vi.fn(async () => true),
  logoutAdmin: vi.fn(async () => undefined),
  setAdminAuthFailureHandler: vi.fn(),
  uploadKnowledgeBaseSources: vi.fn(),
  uploadSources: vi.fn()
}));

describe("Admin knowledge base detail", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => undefined)
      }
    });
    await initI18n("en-US");
    await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));
  });

  async function openDetail() {
    render(<App />);

    expect(await screen.findByLabelText("Username")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Username"), {
      target: {
        value: "admin"
      }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: {
        value: "admin-secret"
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(loginAdmin).toHaveBeenCalledWith({ username: "admin", password: "admin-secret" });
    fireEvent.click(await screen.findByRole("button", { name: "Developer docs" }));
    expect(await screen.findByRole("button", { name: "Back" })).toBeTruthy();
  }

  it("loads a paginated file tree and renders full read-only Markdown preview", async () => {
    await openDetail();

    fireEvent.click(await screen.findByRole("button", { name: "intro.md" }));

    await waitFor(() => {
      expect(fetchKnowledgeBaseFileTree).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        cursor: null
      });
      expect(fetchKnowledgeBaseFileDetail).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        path: "pages/intro.md"
      });
    });
    expect(await screen.findByRole("heading", { name: "Intro", level: 1 })).toBeTruthy();
    expect(screen.getByText(/type: guide/)).toBeTruthy();
  });

  it("renders source files directly in the processing table", async () => {
    await openDetail();

    await waitFor(() => {
      expect(listSourceFiles).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        cursor: null
      });
    });
    expect(screen.getByRole("button", { name: "File processing" }).getAttribute("data-active")).toBe(
      "true"
    );
    expect(screen.queryByText("No file selected")).toBeNull();
    const table = screen.getByRole("table", { name: "File processing" });
    expect(table).toBeTruthy();
    expect(screen.getByTestId("source-file-row-source-001")).toBeTruthy();
    expect(screen.getByTestId("source-file-row-source-002")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Operation" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Current stage" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Generated file" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "File name" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "File ID" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Started" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Ended" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Phase" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Severity" })).toBeNull();
    expect(within(table).getByText("intro.md")).toBeTruthy();
    expect(within(table).getByText("setup.md")).toBeTruthy();
    expect(within(table).getByText("source-001")).toBeTruthy();
    expect(within(table).getByText("source-002")).toBeTruthy();
    expect(within(table).getByText("Running")).toBeTruthy();
    expect(within(table).getByText("Queued")).toBeTruthy();
    expect(within(table).getByText("Upload storage")).toBeTruthy();
    expect(within(table).getByText("Metadata resolution")).toBeTruthy();
    expect(within(table).getAllByText("Pending").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
  });

  it("opens a generated file directly from a completed source-file row", async () => {
    vi.mocked(listSourceFiles).mockResolvedValue({
      items: [
        {
          id: "source-001",
          originalName: "intro.md",
          processingStatus: "completed",
          processingStage: "release_activation",
          processingStartedAt: "2026-06-14T00:00:00.000Z",
          processingEndedAt: "2026-06-14T00:00:10.000Z",
          processingErrorCode: null,
          generatedFileAvailable: true,
          generatedFileId: "file-001",
          generatedFilePath: "pages/intro.md",
          createdAt: "2026-06-14T00:00:00.000Z"
        }
      ],
      nextCursor: null
    });

    await openDetail();

    expect(await screen.findByText("Available")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Open file" }));

    await waitFor(() => {
      expect(fetchKnowledgeBaseFileDetail).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        path: "pages/intro.md"
      });
    });
  });

  it("keeps failed source files out of the generated tree and keeps manual retry visible", async () => {
    vi.mocked(fetchKnowledgeBaseFileTree).mockResolvedValueOnce({
      items: [],
      nextCursor: null
    });
    vi.mocked(listSourceFiles).mockResolvedValueOnce({
      items: [
        {
          id: "source-failed",
          originalName: "broken.md",
          processingStatus: "failed",
          processingStage: "llm_suggestion",
          processingStartedAt: "2026-06-14T00:00:00.000Z",
          processingEndedAt: "2026-06-14T00:00:10.000Z",
          processingErrorCode: "MODEL_OUTPUT_INVALID",
          generatedFileAvailable: false,
          generatedFileId: null,
          generatedFilePath: null,
          createdAt: "2026-06-14T00:00:00.000Z"
        }
      ],
      nextCursor: null
    });

    await openDetail();

    expect(screen.queryByRole("button", { name: "broken.md" })).toBeNull();
    expect(await screen.findByText("Pending")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry parsing" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
  });

  it("appends source-file pages with bounded cursor requests", async () => {
    vi.mocked(listSourceFiles)
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-001",
            originalName: "intro.md",
            processingStatus: "completed",
            processingStage: "release_activation",
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: "2026-06-14T00:00:10.000Z",
            processingErrorCode: null,
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: "source-cursor-001"
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-002",
            originalName: "setup.md",
            processingStatus: "completed",
            processingStage: "release_activation",
            processingStartedAt: "2026-06-14T00:00:11.000Z",
            processingEndedAt: "2026-06-14T00:00:20.000Z",
            processingErrorCode: null,
            createdAt: "2026-06-14T00:00:11.000Z"
          }
        ],
        nextCursor: null
      });

    await openDetail();

    const table = screen.getByRole("table", { name: "File processing" });
    expect(within(table).getByText("intro.md")).toBeTruthy();
    expect(within(table).queryByText("setup.md")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await within(table).findByText("setup.md")).toBeTruthy();
    expect(listSourceFiles).toHaveBeenNthCalledWith(1, {
      knowledgeBaseId: "kb-docs",
      cursor: null
    });
    expect(listSourceFiles).toHaveBeenNthCalledWith(2, {
      knowledgeBaseId: "kb-docs",
      cursor: "source-cursor-001"
    });
  });

  it("opens internal Markdown preview links inside the admin file preview", async () => {
    await openDetail();

    fireEvent.click(await screen.findByRole("button", { name: "intro.md" }));

    expect(await screen.findByRole("heading", { name: "Intro", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Generated page" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Generated page" }));

    await waitFor(() => {
      expect(fetchKnowledgeBaseFileDetail).toHaveBeenLastCalledWith({
        knowledgeBaseId: "kb-docs",
        path: "pages/intro.md"
      });
    });
  });

  it("copies the selected generated file URL without exposing storage paths", async () => {
    await openDetail();

    fireEvent.click(await screen.findByRole("button", { name: "intro.md" }));
    expect(screen.queryByRole("button", { name: "Copy search URL" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy links URL" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Copy file URL" }));

    await waitFor(() => {
      expect(fetchKnowledgeBasePublicUrls).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs"
      });
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "https://kb.example.com/openapi/v1/knowledge-bases/kb-docs/files/content?path=pages%2Fintro.md"
      );
    });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(
      expect.stringContaining("tenant/demo")
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(
      expect.stringContaining("release-")
    );
  });

  it("appends file tree pages without replacing the current page", async () => {
    vi.mocked(fetchKnowledgeBaseFileTree)
      .mockResolvedValueOnce({
        items: [
          {
            id: "tree-001",
            name: "intro.md",
            logicalPath: "pages/intro.md",
            entryType: "file",
            bundleFileId: "file-001"
          }
        ],
        nextCursor: "tree-cursor-001"
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "tree-002",
            name: "setup.md",
            logicalPath: "pages/setup.md",
            entryType: "file",
            bundleFileId: "file-002"
          }
        ],
        nextCursor: null
      });

    await openDetail();
    expect(await screen.findByRole("button", { name: "intro.md" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("button", { name: "setup.md" })).toBeTruthy();
    expect(fetchKnowledgeBaseFileTree).toHaveBeenNthCalledWith(1, {
      knowledgeBaseId: "kb-docs",
      cursor: null
    });
    expect(fetchKnowledgeBaseFileTree).toHaveBeenNthCalledWith(2, {
      knowledgeBaseId: "kb-docs",
      cursor: "tree-cursor-001"
    });
  });

  it("appends file processing pages with bounded cursor requests", async () => {
    vi.mocked(listSourceFiles)
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-001",
            originalName: "intro.md",
            processingStatus: "running",
            processingStage: "metadata_resolution",
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: null,
            processingErrorCode: null,
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: "source-cursor-001"
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-002",
            originalName: "setup.md",
            processingStatus: "completed",
            processingStage: "release_activation",
            processingStartedAt: "2026-06-13T00:00:00.000Z",
            processingEndedAt: "2026-06-13T00:00:10.000Z",
            processingErrorCode: null,
            createdAt: "2026-06-13T00:00:00.000Z"
          }
        ],
        nextCursor: null
      });

    await openDetail();
    expect(await screen.findByTestId("source-file-row-source-001")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByTestId("source-file-row-source-002")).toBeTruthy();
    expect(listSourceFiles).toHaveBeenNthCalledWith(1, {
      knowledgeBaseId: "kb-docs",
      cursor: null
    });
    expect(listSourceFiles).toHaveBeenNthCalledWith(2, {
      knowledgeBaseId: "kb-docs",
      cursor: "source-cursor-001"
    });
  });

  it("deletes a source-backed page from the file tree row menu", async () => {
    vi.mocked(listSourceFiles).mockResolvedValue({
        items: [
          {
            id: "source-001",
            originalName: "intro.md",
            processingStatus: "completed",
            processingStage: "release_activation",
            processingStartedAt: "2026-06-14T00:00:03.000Z",
            processingEndedAt: "2026-06-14T00:00:04.000Z",
            processingErrorCode: null,
            createdAt: "2026-06-14T00:00:03.000Z"
          }
        ],
        nextCursor: null
      });

    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "intro.md" }));
    expect(await screen.findByRole("heading", { name: "Intro", level: 1 })).toBeTruthy();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "File actions: intro.md" }), {
      button: 0,
      ctrlKey: false
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete Markdown file" });
    expect(dialog).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteKnowledgeBaseFile).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        path: "pages/intro.md"
      });
      expect(screen.queryByRole("alertdialog", { name: "Delete Markdown file" })).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "File processing" }).getAttribute("data-active")).toBe(
        "true"
      );
      expect(screen.queryByRole("heading", { name: "Intro", level: 1 })).toBeNull();
    });
    expect(await screen.findByTestId("source-file-row-source-001")).toBeTruthy();
    expect(screen.queryByText("Delete file")).toBeNull();
    expect(fetchKnowledgeBaseFileTree).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docs",
      cursor: null
    });
  });

  it("does not show file delete actions for generated system files", async () => {
    vi.mocked(fetchKnowledgeBaseFileTree).mockResolvedValueOnce({
      items: [
        {
          id: "tree-index",
          name: "index.md",
          logicalPath: "index.md",
          entryType: "file",
          bundleFileId: "file-index",
          sourceFileId: null,
          fileKind: "index",
          deletable: false
        }
      ],
      nextCursor: null
    });

    await openDetail();

    expect(await screen.findByRole("button", { name: "index.md" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "File actions: index.md" })).toBeNull();
  });

  it("loads a directory page only when the directory is opened", async () => {
    vi.mocked(fetchKnowledgeBaseFileTree)
      .mockResolvedValueOnce({
        items: [
          {
            id: "tree-pages",
            name: "pages",
            logicalPath: "pages",
            entryType: "directory",
            bundleFileId: null
          }
        ],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "tree-intro",
            name: "intro.md",
            logicalPath: "pages/intro.md",
            entryType: "file",
            bundleFileId: "file-001"
          }
        ],
        nextCursor: null
      });

    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "pages" }));

    expect(await screen.findByRole("button", { name: "intro.md" })).toBeTruthy();
    expect(fetchKnowledgeBaseFileTree).toHaveBeenNthCalledWith(2, {
      knowledgeBaseId: "kb-docs",
      parentPath: "pages",
      cursor: null
    });
  });

  it("keeps source, release, and bundle file lists out of the sidebar detail view", async () => {
    await openDetail();

    expect(await screen.findByRole("button", { name: "File processing" })).toBeTruthy();
    expect(screen.queryByText("Source files")).toBeNull();
    expect(screen.queryByText("Releases")).toBeNull();
    expect(screen.queryByText("Bundle files")).toBeNull();
    expect(listReleases).not.toHaveBeenCalled();
    expect(listBundleFiles).not.toHaveBeenCalled();
  });
});
