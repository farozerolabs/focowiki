import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { initI18n } from "../src/i18n";
import {
  fetchKnowledgeBaseFileTree,
  listKnowledgeBases,
  listSourceFiles,
  loginAdmin,
  logoutAdmin
} from "../src/lib/admin-api";
import {
  cancelFolderUpload,
  resumeUploadSession,
  runUploadSession
} from "../src/lib/upload-session-client";
import { selectDirectoryFiles } from "../src/lib/directory-picker";

vi.mock("../src/lib/admin-api", () => ({
  adminFetch: vi.fn(async (path: string) => {
    if (path.includes("/operations")) {
      return new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("{}", { status: 404 });
  }),
  checkAdminSession: vi.fn(async () => false),
  createKnowledgeBase: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  deleteKnowledgeBaseFile: vi.fn(),
  fetchKnowledgeBaseFileDetail: vi.fn(),
  fetchKnowledgeBaseFileTree: vi.fn(async () => ({
    items: [],
    nextCursor: null
  })),
  fetchKnowledgeBase: vi.fn(async () => null),
  fetchKnowledgeBaseProcessingSummary: vi.fn(async () => ({
    activeGenerationId: null,
    pendingDispatch: {
      pendingCount: 0,
      oldestPendingAt: null,
      paused: false,
      pausedReason: null
    },
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
    publicationProgress: {
      generationId: null, stage: null, processedImpactCount: 0, totalImpactCount: 0,
      touchedShardCount: 0, oldestDirtyAt: null, queuedAt: null, startedAt: null,
      heartbeatAt: null, completedAt: null, lastSuccessAt: null,
      safeErrorCode: null, safeErrorMessage: null
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
        activeGenerationId: null
      }
    ],
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
  uploadSources: vi.fn()
}));

vi.mock("../src/lib/upload-session-client", () => ({
  cancelFolderUpload: vi.fn(),
  resumeUploadSession: vi.fn(),
  runUploadSession: vi.fn()
}));

vi.mock("../src/lib/directory-picker", () => ({
  selectDirectoryFiles: vi.fn(async () => ({ status: "cancelled" }))
}));

describe("Admin upload file picker", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
    await initI18n("en-US");
    await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the upload dialog and refreshes source-file rows after submitting Markdown files", async () => {
    vi.mocked(runUploadSession).mockResolvedValueOnce(createCompletedUploadResult());
    vi.mocked(listSourceFiles)
      .mockResolvedValueOnce({
        items: [],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-new",
            name: "intro.md",
            relativePath: "intro.md",
            state: "queued",
            currentStage: "upload_storage",
            processingStartedAt: null,
            processingEndedAt: null,
            failure: null,
            actions: [],
            createdAt: "2026-06-14T00:00:00.000Z"
          },
          {
            id: "source-ongoing",
            name: "ongoing.md",
            relativePath: "ongoing.md",
            state: "running",
            currentStage: "llm_suggestion",
            processingStartedAt: "2026-06-14T00:00:01.000Z",
            processingEndedAt: null,
            failure: null,
            actions: [],
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
    expect(runUploadSession).toHaveBeenCalled();
    expect(vi.mocked(runUploadSession).mock.calls[0]?.[0]).toMatchObject({
      knowledgeBaseId: "kb-docs",
      files: [file]
    });
  });

  it("resets source-file pagination to the first page after upload is accepted", async () => {
    vi.mocked(runUploadSession).mockResolvedValueOnce(createCompletedUploadResult());
    vi.mocked(listSourceFiles)
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-page-one",
            name: "page-one.md",
            relativePath: "page-one.md",
            state: "pending_publication",
            currentStage: "generation_activation",
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: "2026-06-14T00:00:01.000Z",
            failure: null,
            actions: [],
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: "cursor-page-two"
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-page-two",
            name: "page-two.md",
            relativePath: "page-two.md",
            state: "pending_publication",
            currentStage: "generation_activation",
            processingStartedAt: "2026-06-14T00:00:01.000Z",
            processingEndedAt: "2026-06-14T00:00:02.000Z",
            failure: null,
            actions: [],
            createdAt: "2026-06-14T00:00:01.000Z"
          }
        ],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-new",
            name: "new.md",
            relativePath: "new.md",
            state: "queued",
            currentStage: "upload_storage",
            processingStartedAt: null,
            processingEndedAt: null,
            failure: null,
            actions: [],
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

    expect(screen.getByText("Markdown relative paths must be unique")).toBeTruthy();
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

  it("preserves nested folder paths and allows equal basenames in different directories", async () => {
    render(<App />);

    await openKnowledgeBaseDetail();

    const englishIntro = fileWithRelativePath("English", "handbook/en/intro.md");
    const chineseIntro = fileWithRelativePath("Chinese", "handbook/zh/intro.md");
    vi.mocked(selectDirectoryFiles).mockResolvedValueOnce({
      status: "selected",
      files: [englishIntro, chineseIntro]
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));

    expect(await screen.findByText("handbook/en/intro.md")).toBeTruthy();
    expect(await screen.findByText("handbook/zh/intro.md")).toBeTruthy();
    expect(screen.queryByText("Markdown relative paths must be unique")).toBeNull();
    expect(document.querySelector("[webkitdirectory]")).toBeNull();
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it("rejects nested non-Markdown and generated navigation paths", async () => {
    render(<App />);

    await openKnowledgeBaseDetail();

    const plainText = fileWithRelativePath("Plain text", "handbook/assets/notes.txt", "text/plain");
    vi.mocked(selectDirectoryFiles).mockResolvedValueOnce({
      status: "selected",
      files: [plainText]
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));

    expect(await screen.findByText("Upload cleaned .md files only")).toBeTruthy();
    expect(screen.getAllByText("handbook/assets/notes.txt").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));

    const reservedNavigation = fileWithRelativePath(
      "Reserved",
      "handbook/index-map-000001.md"
    );
    vi.mocked(selectDirectoryFiles).mockResolvedValueOnce({
      status: "selected",
      files: [reservedNavigation]
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));

    expect(await screen.findByText("Upload cleaned .md files only")).toBeTruthy();
    expect(screen.getAllByText("handbook/index-map-000001.md").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("resumes a created upload session after a recoverable transfer failure", async () => {
    vi.mocked(runUploadSession).mockImplementationOnce(async (input) => {
      input.onSessionReady?.("upload-session-resume", createUploadTransport());
      return {
        ok: false,
        failure: { messageKey: "errors.uploadFailed" },
        sessionId: "upload-session-resume"
      };
    });
    vi.mocked(resumeUploadSession).mockResolvedValueOnce(createCompletedUploadResult());
    render(<App />);

    await openKnowledgeBaseDetail();

    const file = new File(["# Resume"], "resume.md", { type: "text/markdown" });
    fireEvent.change(document.querySelector<HTMLInputElement>("#source-files") as HTMLInputElement, {
      target: { files: [file] }
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByRole("button", { name: "Resume upload" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume upload" }));

    await waitFor(() => {
      expect(resumeUploadSession).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeBaseId: "kb-docs",
          sessionId: "upload-session-resume",
          files: [file],
          transport: createUploadTransport()
        })
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("ignores a stale upload completion after the user cancels", async () => {
    let resolveUpload: ((result: ReturnType<typeof createCompletedUploadResult>) => void) | null = null;
    vi.mocked(cancelFolderUpload).mockResolvedValueOnce(undefined);
    vi.mocked(runUploadSession).mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          input.onSessionReady?.("upload-session-cancel", createUploadTransport());
          resolveUpload = resolve;
        })
    );
    render(<App />);

    await openKnowledgeBaseDetail();

    fireEvent.change(document.querySelector<HTMLInputElement>("#source-files") as HTMLInputElement, {
      target: { files: [new File(["# Cancel"], "cancel.md", { type: "text/markdown" })] }
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel upload" }));

    await waitFor(() => {
      expect(cancelFolderUpload).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        sessionId: "upload-session-cancel"
      });
      expect(screen.getByText("No Markdown files selected")).toBeTruthy();
    });
    await act(async () => {
      resolveUpload?.(createCompletedUploadResult());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("No Markdown files selected")).toBeTruthy();
  });

  it("refreshes active source file pages with bounded polling", async () => {
    vi.mocked(fetchKnowledgeBaseFileTree).mockImplementation(async (input) => {
      if (input.parentPath === "pages") {
        return {
          items: [
            {
              id: "tree-page-intro",
              name: "intro.md",
              logicalPath: "pages/intro.md",
              entryType: "file",
              generatedFileId: "bundle-intro"
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
            generatedFileId: null
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
            name: "intro.md",
            relativePath: "intro.md",
            state: "running",
            currentStage: "metadata_resolution",
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: null,
            failure: null,
            actions: [],
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-new",
            name: "intro.md",
            relativePath: "intro.md",
            state: "visible",
            currentStage: "generation_activation",
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: "2026-06-14T00:00:05.000Z",
            failure: null,
            actions: [
              {
                kind: "open_generated_file",
                method: "GET",
                href: "/admin/api/knowledge-bases/kb-docs/files/content?path=pages%2Fintro.md",
                scope: "source_file"
              }
            ],
            generatedFileAvailable: true,
            generatedFileId: "bundle-intro",
            generatedFilePath: "pages/intro.md",
            createdAt: "2026-06-14T00:00:00.000Z"
          },
          {
            id: "source-ongoing",
            name: "ongoing.md",
            relativePath: "ongoing.md",
            state: "running",
            currentStage: "llm_suggestion",
            processingStartedAt: "2026-06-14T00:00:01.000Z",
            processingEndedAt: null,
            failure: null,
            actions: [],
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
          within(screen.getByTestId("source-file-row-source-new")).getByText("Visible")
        ).toBeTruthy();
      },
      { timeout: 3_000 }
    );
    fireEvent.click(await screen.findByRole("button", { name: "pages" }));
    await waitFor(() => {
      expect(vi.mocked(listSourceFiles).mock.calls.length).toBeGreaterThanOrEqual(2);
      const rootRefreshCalls = vi
        .mocked(fetchKnowledgeBaseFileTree)
        .mock.calls.filter(([input]) => input.parentPath === undefined);

      expect(rootRefreshCalls).toHaveLength(1);
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

    expect(await screen.findByText("Focowiki")).toBeTruthy();
    expect(screen.queryByText("输入部署管理员账号和密码以管理 Markdown 知识包生成。")).toBeNull();
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

function createCompletedUploadResult() {
  const now = "2026-06-14T00:00:00.000Z";
  return {
    ok: true as const,
    session: {
      id: "upload-session-test",
      knowledgeBaseId: "kb-docs",
      state: "completed" as const,
      declaredFileCount: 1,
      declaredByteCount: 64,
      counts: {
        selected: 1,
        uploadRequired: 1,
        skippedExisting: 0,
        waitingReservation: 0,
        rejectedDeleting: 0,
        uploaded: 1,
        failed: 0,
        finalized: 1
      },
      expiresAt: now
    }
  };
}

function createUploadTransport() {
  return {
    manifestPageSize: 500
  };
}

function fileWithRelativePath(content: string, relativePath: string, type = "text/markdown"): File {
  const file = new File([content], relativePath.split("/").at(-1) ?? relativePath, { type });
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: relativePath
  });
  return file;
}
