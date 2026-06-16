import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { initI18n } from "../src/i18n";
import {
  fetchUploadTaskDetail,
  fetchKnowledgeBaseFileTree,
  listKnowledgeBases,
  listUploadTasks,
  loginAdmin,
  logoutAdmin,
  uploadKnowledgeBaseSources
} from "../src/lib/admin-api";

vi.mock("../src/lib/admin-api", () => ({
  checkAdminSession: vi.fn(async () => false),
  createKnowledgeBase: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  deleteKnowledgeBaseFile: vi.fn(),
  fetchKnowledgeBaseFileDetail: vi.fn(),
  fetchKnowledgeBaseFileTree: vi.fn(async () => ({
    items: [],
    nextCursor: null
  })),
  fetchKnowledgeBasePublicUrls: vi.fn(async () => null),
  fetchResultFile: vi.fn(),
  fetchResultTree: vi.fn(async () => []),
  fetchUploadTaskDetail: vi.fn(),
  generateBundle: vi.fn(),
  listKnowledgeBases: vi.fn(async () => ({
    items: [
      {
        id: "kb-docs",
        name: "Developer docs",
        description: "Markdown product knowledge",
        activeReleaseId: null
      }
    ],
    nextCursor: null
  })),
  listUploadTasks: vi.fn(async () => ({
    items: [],
    nextCursor: null
  })),
  listBundleFiles: vi.fn(async () => ({
    items: [],
    nextCursor: null
  })),
  listReleases: vi.fn(async () => ({
    items: [],
    nextCursor: null
  })),
  listSourceFiles: vi.fn(async () => ({
    items: [],
    nextCursor: null
  })),
  loginAdmin: vi.fn(async () => true),
  logoutAdmin: vi.fn(async () => undefined),
  setAdminAuthFailureHandler: vi.fn(),
  renderPreview: vi.fn(),
  uploadKnowledgeBaseSources: vi.fn(),
  uploadSources: vi.fn()
}));

describe("Admin upload file picker", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await initI18n("en-US");
    await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));
  });

  it("closes the upload dialog and refreshes task rows after submitting Markdown files", async () => {
    vi.mocked(uploadKnowledgeBaseSources).mockResolvedValueOnce({
      task: {
        id: "task-new",
        startedAt: "2026-06-14T00:00:00.000Z",
        endedAt: null,
        lifecycle: "running",
        sourceCount: 1
      }
    });
    vi.mocked(listUploadTasks)
      .mockResolvedValueOnce({
        items: [],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "task-new",
            startedAt: "2026-06-14T00:00:00.000Z",
            endedAt: null,
            lifecycle: "running",
            sourceCount: 1
          }
        ],
        nextCursor: null
      });
    vi.mocked(fetchUploadTaskDetail).mockResolvedValue({
      task: {
        id: "task-new",
        startedAt: "2026-06-14T00:00:00.000Z",
        endedAt: null,
        lifecycle: "running",
        sourceCount: 1
      },
      phaseDetails: {
        items: [],
        nextCursor: null
      },
      sourceFiles: {
        items: [
          {
            id: "source-new",
            originalName: "intro.md",
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: null
      }
    });
    render(<App />);

    await openKnowledgeBaseDetail();

    const input = document.querySelector<HTMLInputElement>("#source-files");
    const file = new File(["---\ntype: page\ntitle: Intro\n---\n# Intro"], "intro.md", {
      type: "text/markdown"
    });
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [file]
      }
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Upload" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("button", { name: "Upload tasks" }).getAttribute("data-active")).toBe(
        "true"
      );
      expect(screen.getByText("task-new")).toBeTruthy();
    });
    expect(uploadKnowledgeBaseSources).toHaveBeenCalled();
    expect(uploadKnowledgeBaseSources).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docs",
      files: [file]
    });
    expect(fetchUploadTaskDetail).not.toHaveBeenCalled();
  });

  it("shows a multi-file batch summary before upload", async () => {
    render(<App />);

    await openKnowledgeBaseDetail();

    const input = document.querySelector<HTMLInputElement>("#source-files");
    const intro = new File(["Intro"], "intro.md", { type: "text/markdown" });
    const setup = new File(["Setup"], "setup.md", { type: "text/markdown" });
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [intro, setup]
      }
    });

    expect(screen.getByText("2 selected Markdown files")).toBeTruthy();
    expect(screen.getByText("Total size: 10 B")).toBeTruthy();
    expect(screen.getByText("intro.md")).toBeTruthy();
    expect(screen.getByText("setup.md")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it("removes individual selected files and clears the upload batch", async () => {
    render(<App />);

    await openKnowledgeBaseDetail();

    const input = document.querySelector<HTMLInputElement>("#source-files");
    const intro = new File(["Intro"], "intro.md", { type: "text/markdown" });
    const setup = new File(["Setup"], "setup.md", { type: "text/markdown" });
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [intro, setup]
      }
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove intro.md" }));
    expect(screen.queryByText("intro.md")).toBeNull();
    expect(screen.getByText("setup.md")).toBeTruthy();
    expect(screen.getByText("1 selected Markdown file")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText("setup.md")).toBeNull();
    expect(screen.getByText("No Markdown files selected")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("warns about duplicate or unsupported selected files before submit", async () => {
    render(<App />);

    await openKnowledgeBaseDetail();

    const input = document.querySelector<HTMLInputElement>("#source-files");
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [
          new File(["One"], "intro.md", { type: "text/markdown" }),
          new File(["Two"], "INTRO.md", { type: "text/markdown" })
        ]
      }
    });

    expect(screen.getByText("Markdown file names must be unique")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(
      true
    );

    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [new File(["Plain text"], "notes.txt", { type: "text/plain" })]
      }
    });

    expect(screen.getByText("Upload cleaned .md files only")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("refreshes upload tasks on an interval while the detail page is open", async () => {
    vi.mocked(fetchKnowledgeBaseFileTree).mockImplementation(async (input) => {
      if (input.parentPath === "pages") {
        return {
          items: [
            {
              id: "tree-page-intro",
              name: "intro.md",
              logicalPath: "pages/intro.md",
              entryType: "file",
              bundleFileId: "bundle-intro"
            }
          ],
          nextCursor: null
        };
      }

      return {
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
      };
    });
    vi.mocked(listUploadTasks)
      .mockResolvedValueOnce({
        items: [
          {
            id: "task-new",
            startedAt: "2026-06-14T00:00:00.000Z",
            endedAt: null,
            lifecycle: "running",
            sourceCount: 1
          }
        ],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "task-new",
            startedAt: "2026-06-14T00:00:00.000Z",
            endedAt: "2026-06-14T00:00:05.000Z",
            lifecycle: "ended",
            sourceCount: 1
          }
        ],
        nextCursor: null
      });
    vi.mocked(fetchUploadTaskDetail).mockImplementation(async () => ({
      task: {
        id: "task-new",
        startedAt: "2026-06-14T00:00:00.000Z",
        endedAt: "2026-06-14T00:00:05.000Z",
        lifecycle: "ended",
        sourceCount: 1
      },
      phaseDetails: {
        items: [],
        nextCursor: null
      },
      sourceFiles: {
        items: [],
        nextCursor: null
      }
    }));

    render(<App />);
    await openKnowledgeBaseDetailPage();
    fireEvent.click(await screen.findByRole("button", { name: "pages" }));

    expect(await screen.findByText("Upload parsing task is running")).toBeTruthy();

    expect(await screen.findByText("Upload parsing task ended", {}, { timeout: 3_000 })).toBeTruthy();
    await waitFor(() => {
      const pageRefreshCalls = vi
        .mocked(fetchKnowledgeBaseFileTree)
        .mock.calls.filter(([input]) => input.parentPath === "pages");

      expect(pageRefreshCalls.length).toBeGreaterThanOrEqual(2);
    });
  }, 5_000);

  async function openKnowledgeBaseDetail() {
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
    expect(await screen.findByRole("button", { name: "Developer docs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Developer docs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
    expect(await screen.findByText("Markdown sources")).toBeTruthy();
  }

  async function openKnowledgeBaseDetailPage() {
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
    expect(await screen.findByRole("button", { name: "Developer docs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Developer docs" }));
    expect(await screen.findByRole("button", { name: "Upload" })).toBeTruthy();
  }

  it("shows selected Markdown file names and enables upload", async () => {
    render(<App />);

    await openKnowledgeBaseDetail();

    const input = document.querySelector<HTMLInputElement>("#source-files");
    expect(input).not.toBeNull();

    const file = new File(["# Intro"], "intro.md", { type: "text/markdown" });
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [file]
      }
    });

    expect(screen.queryByText("intro.md")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it("does not render upload metadata inputs when Markdown has frontmatter", async () => {
    render(<App />);

    await openKnowledgeBaseDetail();

    const input = document.querySelector<HTMLInputElement>("#source-files");
    const file = new File(
      [
        [
          "---",
          "type: guide",
          "title: Upload Guide",
          "description: How to upload Markdown files.",
          "tags:",
          "  - upload",
          "  - markdown",
          "---",
          "# Upload Guide"
        ].join("\n")
      ],
      "upload-guide.md",
      { type: "text/markdown" }
    );

    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [file]
      }
    });

    expect(screen.queryByLabelText("Default type")).toBeNull();
    expect(screen.queryByLabelText("Default title")).toBeNull();
    expect(screen.queryByLabelText("Default description")).toBeNull();
    expect(screen.queryByLabelText("Default tags")).toBeNull();
    expect(screen.getByText("upload-guide.md")).toBeTruthy();
  });

  it("does not ask for metadata when selected Markdown has no frontmatter", async () => {
    render(<App />);

    await openKnowledgeBaseDetail();

    const input = document.querySelector<HTMLInputElement>("#source-files");
    const file = new File(["# No Frontmatter"], "no-frontmatter.md", {
      type: "text/markdown"
    });

    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [file]
      }
    });

    expect(screen.queryByLabelText("Default type")).toBeNull();
    expect(screen.queryByLabelText("Default title")).toBeNull();
    expect(screen.queryByLabelText("Default description")).toBeNull();
    expect(screen.queryByLabelText("Default tags")).toBeNull();
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it("uses a native file input as the chooser click target", async () => {
    render(<App />);

    await openKnowledgeBaseDetail();

    const input = document.querySelector<HTMLInputElement>("#source-files");
    expect(input?.type).toBe("file");
    expect(input?.multiple).toBe(true);
    expect(input?.accept).toBe(".md");
  });

  it("logs out and returns to the credential form", async () => {
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

    expect(await screen.findByRole("button", { name: "Developer docs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => {
      expect(logoutAdmin).toHaveBeenCalled();
      expect(screen.getByLabelText("Username")).toBeTruthy();
    });
  });

  it("keeps protected UI unavailable when login fails", async () => {
    vi.mocked(loginAdmin).mockResolvedValueOnce(false);
    render(<App />);

    expect(await screen.findByLabelText("Username")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Username"), {
      target: {
        value: "admin"
      }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: {
        value: "wrong"
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Invalid admin credentials")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Developer docs" })).toBeNull();
  });

  it("switches login page language from the page controls", async () => {
    render(<App />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Language" }), {
      button: 0,
      ctrlKey: false
    });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Chinese" }));

    expect(await screen.findByText("管理端访问")).toBeTruthy();
    expect(screen.getByLabelText("账号")).toBeTruthy();
    expect(screen.getByLabelText("密码")).toBeTruthy();
  });

  it("loads knowledge base cards after login", async () => {
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

    expect(await screen.findByRole("button", { name: "Developer docs" })).toBeTruthy();
    expect(listKnowledgeBases).toHaveBeenCalledWith({});
    expect(screen.queryByText("Markdown sources")).toBeNull();
  });
});
