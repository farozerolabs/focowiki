import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { initI18n } from "../src/i18n";
import {
  fetchKnowledgeBaseFileTree,
  listKnowledgeBases,
  listSourceFiles,
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
  fetchKnowledgeBaseProcessingSummary: vi.fn(async () => ({
    sourceFileJobs: {
      queuedCount: 0,
      runningCount: 0,
      completedCount: 0,
      failedCount: 0,
      deadLetterCount: 0,
      oldestQueuedAt: null,
      oldestQueuedAgeSeconds: null
    },
    publicationJobs: {
      queuedCount: 0,
      runningCount: 0,
      completedCount: 0,
      failedCount: 0,
      deadLetterCount: 0,
      oldestQueuedAt: null,
      oldestQueuedAgeSeconds: null
    },
    dirtySourceFiles: {
      count: 0,
      oldestDirtyAt: null
    }
  })),
  fetchKnowledgeBasePublicUrls: vi.fn(async () => null),
  fetchResultFile: vi.fn(),
  fetchResultTree: vi.fn(async () => []),
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
  listSourceFiles: vi.fn(async () => ({
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

  it("closes the upload dialog and refreshes source-file rows after submitting Markdown files", async () => {
    vi.mocked(uploadKnowledgeBaseSources).mockResolvedValueOnce({
      files: [
        {
          id: "source-new",
          originalName: "intro.md",
          processingStatus: "queued",
          processingStage: "upload_storage",
          processingStartedAt: null,
          processingEndedAt: null,
          processingErrorCode: null,
          createdAt: "2026-06-14T00:00:00.000Z"
        }
      ]
    });
    vi.mocked(listSourceFiles)
      .mockResolvedValueOnce({
        items: [],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-new",
            originalName: "intro.md",
            processingStatus: "queued",
            processingStage: "upload_storage",
            processingStartedAt: null,
            processingEndedAt: null,
            processingErrorCode: null,
            createdAt: "2026-06-14T00:00:00.000Z"
          },
          {
            id: "source-ongoing",
            originalName: "ongoing.md",
            processingStatus: "running",
            processingStage: "llm_suggestion",
            processingStartedAt: "2026-06-14T00:00:01.000Z",
            processingEndedAt: null,
            processingErrorCode: null,
            createdAt: "2026-06-14T00:00:01.000Z"
          }
        ],
        nextCursor: null
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
      expect(screen.getByRole("button", { name: "File processing" }).getAttribute("data-active")).toBe(
        "true"
      );
      expect(screen.getByText("intro.md")).toBeTruthy();
    });
    expect(uploadKnowledgeBaseSources).toHaveBeenCalled();
    expect(uploadKnowledgeBaseSources).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docs",
      files: [file]
    });
  });

  it("resets source-file pagination to the first page after upload is accepted", async () => {
    vi.mocked(uploadKnowledgeBaseSources).mockResolvedValueOnce({
      files: [
        {
          id: "source-new",
          originalName: "new.md",
          processingStatus: "queued",
          processingStage: "upload_storage",
          processingStartedAt: null,
          processingEndedAt: null,
          processingErrorCode: null,
          createdAt: "2026-06-14T00:00:03.000Z"
        }
      ]
    });
    vi.mocked(listSourceFiles)
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-page-one",
            originalName: "page-one.md",
            processingStatus: "completed",
            processingStage: "release_activation",
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: "2026-06-14T00:00:01.000Z",
            processingErrorCode: null,
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: "cursor-page-two"
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-page-two",
            originalName: "page-two.md",
            processingStatus: "completed",
            processingStage: "release_activation",
            processingStartedAt: "2026-06-14T00:00:01.000Z",
            processingEndedAt: "2026-06-14T00:00:02.000Z",
            processingErrorCode: null,
            createdAt: "2026-06-14T00:00:01.000Z"
          }
        ],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-new",
            originalName: "new.md",
            processingStatus: "queued",
            processingStage: "upload_storage",
            processingStartedAt: null,
            processingEndedAt: null,
            processingErrorCode: null,
            createdAt: "2026-06-14T00:00:03.000Z"
          }
        ],
        nextCursor: "cursor-page-two"
      });
    render(<App />);

    await openKnowledgeBaseDetailPage();
    expect(await screen.findByTestId("source-file-row-source-page-one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(await screen.findByTestId("source-file-row-source-page-two")).toBeTruthy();
    expect(screen.queryByTestId("source-file-row-source-page-one")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    const input = document.querySelector<HTMLInputElement>("#source-files");
    const file = new File(["# New"], "new.md", { type: "text/markdown" });
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [file]
      }
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Upload" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByTestId("source-file-row-source-new")).toBeTruthy();
      expect(screen.queryByTestId("source-file-row-source-page-two")).toBeNull();
      expect(screen.getByText("Page 1")).toBeTruthy();
    });
    expect(listSourceFiles).toHaveBeenNthCalledWith(1, {
      knowledgeBaseId: "kb-docs",
      cursor: null
    });
    expect(listSourceFiles).toHaveBeenNthCalledWith(2, {
      knowledgeBaseId: "kb-docs",
      cursor: "cursor-page-two"
    });
    expect(listSourceFiles).toHaveBeenNthCalledWith(3, {
      knowledgeBaseId: "kb-docs",
      cursor: null
    });
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

  it("refreshes source files on an interval while the detail page is open", async () => {
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
    vi.mocked(listSourceFiles)
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-new",
            originalName: "intro.md",
            processingStatus: "running",
            processingStage: "metadata_resolution",
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: null,
            processingErrorCode: null,
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-new",
            originalName: "intro.md",
            processingStatus: "completed",
            processingStage: "release_activation",
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: "2026-06-14T00:00:05.000Z",
            processingErrorCode: null,
            generatedFileAvailable: true,
            generatedFileId: "bundle-intro",
            generatedFilePath: "pages/intro.md",
            createdAt: "2026-06-14T00:00:00.000Z"
          },
          {
            id: "source-ongoing",
            originalName: "ongoing.md",
            processingStatus: "running",
            processingStage: "llm_suggestion",
            processingStartedAt: "2026-06-14T00:00:01.000Z",
            processingEndedAt: null,
            processingErrorCode: null,
            createdAt: "2026-06-14T00:00:01.000Z"
          }
        ],
        nextCursor: null
      });

    render(<App />);
    await openKnowledgeBaseDetailPage();

    expect(
      within(await screen.findByTestId("source-file-row-source-new")).getByText("Running")
    ).toBeTruthy();

    await waitFor(
      () => {
        expect(
          within(screen.getByTestId("source-file-row-source-new")).getByText("Completed")
        ).toBeTruthy();
      },
      { timeout: 3_000 }
    );
    fireEvent.click(await screen.findByRole("button", { name: "pages" }));
    await waitFor(() => {
      const rootRefreshCalls = vi
        .mocked(fetchKnowledgeBaseFileTree)
        .mock.calls.filter(([input]) => input.parentPath === undefined);

      expect(rootRefreshCalls.length).toBeGreaterThanOrEqual(2);
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

    expect(screen.queryAllByText("intro.md").length).toBeGreaterThan(0);
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
