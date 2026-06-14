import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { initI18n } from "../src/i18n";
import {
  fetchKnowledgeBaseFileDetail,
  fetchKnowledgeBaseFileTree,
  fetchKnowledgeBasePublicUrls,
  fetchUploadTaskDetail,
  listBundleFiles,
  listReleases,
  listSourceFiles,
  listUploadTasks,
  loginAdmin,
} from "../src/lib/admin-api";

vi.mock("../src/lib/admin-api", () => ({
  checkAdminSession: vi.fn(async () => false),
  createKnowledgeBase: vi.fn(),
  fetchKnowledgeBaseFileDetail: vi.fn(async () => ({
    file: {
      id: "file-001",
      logicalPath: "pages/intro.md",
      contentType: "text/markdown",
      title: "Intro"
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
        bundleFileId: "file-001"
      }
    ],
    nextCursor: null
  })),
  fetchKnowledgeBasePublicUrls: vi.fn(async () => ({
    index: "https://kb.example.com/kb/kb-docs/index.md",
    search: "https://kb.example.com/kb/kb-docs/_index/search.json",
    links: "https://kb.example.com/kb/kb-docs/_index/links.json"
  })),
  fetchResultFile: vi.fn(),
  fetchResultTree: vi.fn(async () => []),
  fetchUploadTaskDetail: vi.fn(async () => ({
    task: {
      id: "task-001",
      startedAt: "2026-06-14T00:00:00.000Z",
      endedAt: null,
      lifecycle: "running",
      sourceCount: 1
    },
    phaseDetails: {
      items: [
        {
          id: "event-001",
          taskId: "task-001",
          phaseKey: "upload_storage",
          messageKey: "tasks.phase.uploadStorage",
          startedAt: "2026-06-14T00:00:00.000Z",
          endedAt: null,
          severity: "info",
          createdAt: "2026-06-14T00:00:01.000Z"
        },
        {
          id: "event-002",
          taskId: "task-001",
          phaseKey: "metadata_resolution",
          messageKey: "tasks.phase.metadataResolution",
          startedAt: "2026-06-14T00:00:01.000Z",
          endedAt: "2026-06-14T00:00:02.000Z",
          severity: "info",
          createdAt: "2026-06-14T00:00:02.000Z"
        }
      ],
      nextCursor: null
    },
    sourceFiles: {
      items: [
        {
          id: "source-001",
          originalName: "ff8081819c46fdc3019cd19068731f64-intro-e656df554f9e.md",
          createdAt: "2026-06-14T00:00:00.000Z"
        }
      ],
      nextCursor: null
    }
  })),
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
  listUploadTasks: vi.fn(async () => ({
    items: [
      {
        id: "task-001",
        startedAt: "2026-06-14T00:00:00.000Z",
        endedAt: null,
        lifecycle: "running",
        sourceCount: 1
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
  listSourceFiles: vi.fn(async () => ({
    items: [
      {
        id: "source-001",
        originalName: "intro.md",
        createdAt: "2026-06-14T00:00:00.000Z"
      }
    ],
    nextCursor: null
  })),
  loginAdmin: vi.fn(async () => true),
  logoutAdmin: vi.fn(async () => undefined),
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

  it("loads a paginated file tree and renders a read-only Markdown preview", async () => {
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
    expect(screen.queryByText("type: guide")).toBeNull();
  });

  it("renders upload tasks as one table row with an internal phase summary", async () => {
    await openDetail();

    await waitFor(() => {
      expect(listUploadTasks).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        cursor: null
      });
      expect(fetchUploadTaskDetail).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        taskId: "task-001"
      });
    });
    expect(screen.getByRole("button", { name: "Upload tasks" }).getAttribute("data-active")).toBe(
      "true"
    );
    expect(screen.queryByText("Select an upload task")).toBeNull();
    expect(screen.queryByText("No file selected")).toBeNull();
    expect(await screen.findByText("Upload parsing task is running")).toBeTruthy();
    const table = screen.getByRole("table");
    expect(table).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "File name" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Task ID" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Detail" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Started" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Ended" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Phase" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Severity" })).toBeNull();
    expect(within(table).getByText("intro.md")).toBeTruthy();
    expect(within(table).getAllByText("task-001")).toHaveLength(1);
    expect(within(table).getByText("Upload storage / Metadata resolution")).toBeTruthy();
    expect(screen.queryByText("Info")).toBeNull();
    expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
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

  it("copies public knowledge base URLs without exposing storage paths", async () => {
    await openDetail();

    fireEvent.click(await screen.findByRole("button", { name: "intro.md" }));
    expect(screen.queryByRole("button", { name: "Copy search URL" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy links URL" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Copy index URL" }));

    await waitFor(() => {
      expect(fetchKnowledgeBasePublicUrls).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs"
      });
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "https://kb.example.com/kb/kb-docs/index.md"
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

  it("appends task menu pages with bounded cursor requests", async () => {
    vi.mocked(listUploadTasks)
      .mockResolvedValueOnce({
        items: [
          {
            id: "task-001",
            startedAt: "2026-06-14T00:00:00.000Z",
            endedAt: null,
            lifecycle: "running",
            sourceCount: 1
          }
        ],
        nextCursor: "task-cursor-001"
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "task-002",
            startedAt: "2026-06-13T00:00:00.000Z",
            endedAt: "2026-06-13T00:00:10.000Z",
            lifecycle: "ended",
            sourceCount: 3
          }
        ],
        nextCursor: null
      });

    await openDetail();
    expect(await screen.findByText("task-001")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("task-002")).toBeTruthy();
    expect(listUploadTasks).toHaveBeenNthCalledWith(1, {
      knowledgeBaseId: "kb-docs",
      cursor: null
    });
    expect(listUploadTasks).toHaveBeenNthCalledWith(2, {
      knowledgeBaseId: "kb-docs",
      cursor: "task-cursor-001"
    });
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

    expect(await screen.findByRole("button", { name: "Upload tasks" })).toBeTruthy();
    expect(screen.queryByText("Source files")).toBeNull();
    expect(screen.queryByText("Releases")).toBeNull();
    expect(screen.queryByText("Bundle files")).toBeNull();
    expect(listSourceFiles).not.toHaveBeenCalled();
    expect(listReleases).not.toHaveBeenCalled();
    expect(listBundleFiles).not.toHaveBeenCalled();
  });
});
