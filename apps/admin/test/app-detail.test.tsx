import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { initI18n } from "../src/i18n";
import {
  cancelKnowledgeBaseIndexMaintenance,
  deleteKnowledgeBaseSourceDirectory,
  deleteKnowledgeBaseSourceFileTasks,
  fetchKnowledgeBaseFileDetail,
  fetchKnowledgeBaseFileTree,
  fetchKnowledgeBaseIndexMaintenance,
  fetchKnowledgeBaseProcessingSummary,
  fetchKnowledgeBasePublicUrls,
  fetchSourceFile,
  listSourceFiles,
  loginAdmin,
  requestKnowledgeBaseIndexMaintenance,
  searchKnowledgeBaseFileTree,
  adminFetch,
} from "../src/lib/admin-api";

vi.mock("../src/lib/admin-api", () => ({
  adminFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/source-files/source-001") && init?.method === "DELETE") {
      return new Response(JSON.stringify({
        operation: {
          operationId: "operation-delete-intro",
          knowledgeBaseId: "kb-docs",
          kind: "source_file_delete",
          state: "accepted",
          expectedResourceRevision: 2,
          targetKind: "source_file",
          targetId: "source-001",
          candidateRelativePath: null,
          result: null,
          errorCode: null,
          retryGuidance: null,
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:00.000Z",
          completedAt: null
        },
        deletion: { sourceFileId: "source-001" }
      }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (path.includes("/operations")) {
      return new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("{}", { status: 404 });
  }),
  checkAdminSession: vi.fn(async () => false),
  cancelKnowledgeBaseIndexMaintenance: vi.fn(async () => ({
    result: "cancelled"
  })),
  createKnowledgeBase: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  deleteKnowledgeBaseSourceDirectory: vi.fn(async () => ({
    accepted: true,
    operation: {
      operationId: "operation-delete-handbook",
      knowledgeBaseId: "kb-docs",
      kind: "source_directory_delete",
      state: "accepted",
      expectedResourceRevision: 3,
      targetKind: "source_directory",
      targetId: "source-directory-handbook",
      candidateRelativePath: null,
      result: null,
      errorCode: null,
      retryGuidance: null,
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
      completedAt: null
    },
    directoryId: "source-directory-handbook",
    affectedDirectoryCount: 1,
    affectedFileCount: 2
  })),
  deleteKnowledgeBaseSourceFileTasks: vi.fn(async () => ({
    results: [
      {
        sourceFileId: "source-002",
        status: "hidden"
      }
    ],
    summary: {
      deleted: 0,
      hidden: 1,
      skipped: 0
    }
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
        generatedFileId: "file-001",
        sourceFileId: "source-001",
        resourceRevision: 2,
        fileKind: "page",
        deletable: true
      }
    ],
    nextCursor: null
  })),
  fetchKnowledgeBase: vi.fn(async () => null),
  fetchSourceFile: vi.fn(async () => ({
    id: "source-001",
    name: "intro.md",
    relativePath: "intro.md",
    resourceRevision: 2,
    createdAt: "2026-06-14T00:00:00.000Z"
  })),
  searchKnowledgeBaseFileTree: vi.fn(async () => ({
    items: [
      {
        entry: {
          id: "tree-001",
          name: "intro.md",
          logicalPath: "pages/intro.md",
          entryType: "file",
          generatedFileId: "file-001",
          sourceFileId: "source-001",
          fileKind: "page",
          deletable: true
        },
        ancestors: [
          {
            id: "tree-pages",
            name: "pages",
            logicalPath: "pages",
            entryType: "directory",
            generatedFileId: null,
            sourceFileId: null,
            fileKind: null,
            deletable: false
          }
        ]
      }
    ],
    nextCursor: null
  })),
  fetchKnowledgeBaseProcessingSummary: vi.fn(async () => ({
    waitingCount: 1,
    processingCount: 1,
    availableCount: 8,
    errorCount: 0,
    oldestWaitingAt: "2026-07-20T00:00:00.000Z"
  })),
  fetchKnowledgeBaseIndexMaintenance: vi.fn(async () => ({
      requestId: null,
      state: "idle",
      trigger: null,
      stage: null,
      active: false,
      completedCount: 0,
      expectedCount: 0,
      retryCount: 0,
      lastProgressAt: null,
      lastCompletedAt: null,
      maintenanceRequired: true,
      safeErrorCode: null,
      safeErrorMessage: null
  })),
  fetchKnowledgeBasePublicUrls: vi.fn(async () => ({
    index: "https://kb.example.com/openapi/v2/knowledge-bases/kb-docs/files/content?path=index.md",
    search:
      "https://kb.example.com/openapi/v2/knowledge-bases/kb-docs/files/content?path=_index%2Fsearch.json",
    links:
      "https://kb.example.com/openapi/v2/knowledge-bases/kb-docs/files/content?path=_index%2Flinks.json"
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
        activeContentRevision: 1
      }
    ],
    nextCursor: null
  })),
  listSourceFiles: vi.fn(async () => ({
    items: [
      {
        id: "source-001",
        name: "intro.md",
        relativePath: "intro.md",
        state: "processing",
        blockingWorkKind: "prepare",
        requiredWorkCount: 8,
        completedWorkCount: 1,
        activeWorkKinds: ["prepare"],
        retryingWorkKind: null,
        processingStartedAt: "2026-06-14T00:00:00.000Z",
        processingEndedAt: null,
        failure: null,
        actions: [],
        createdAt: "2026-06-14T00:00:00.000Z"
      },
      {
        id: "source-002",
        name: "setup.md",
        relativePath: "setup.md",
        state: "waiting",
        blockingWorkKind: "prepare",
        requiredWorkCount: 8,
        completedWorkCount: 0,
        activeWorkKinds: [],
        retryingWorkKind: null,
        processingStartedAt: "2026-06-14T00:00:01.000Z",
        processingEndedAt: null,
        failure: null,
        actions: [],
        createdAt: "2026-06-14T00:00:01.000Z"
      }
    ],
    nextCursor: null
  })),
  loginAdmin: vi.fn(async () => ({ authenticated: true, error: null, retryAfterSeconds: null })),
  logoutAdmin: vi.fn(async () => undefined),
  requestKnowledgeBaseIndexMaintenance: vi.fn(async () => ({
    result: "accepted",
    maintenance: {
      requestId: "index-maintenance-001",
      state: "queued",
      trigger: "manual",
      active: true,
      stage: "queued",
      completedCount: 0,
      expectedCount: 0,
      lastProgressAt: null
    }
  })),
  setAdminAuthFailureHandler: vi.fn(),
  uploadKnowledgeBaseSources: vi.fn(),
  uploadSources: vi.fn()
}));

describe("Admin knowledge base detail", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024
    });
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => undefined)
      }
    });
    await initI18n("en-US");
    await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));
  });

  async function openDetail(options: { expectSidebarBackButton?: boolean } = {}) {
    const expectSidebarBackButton = options.expectSidebarBackButton ?? true;

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
    if (expectSidebarBackButton) {
      expect(await screen.findByRole("button", { name: "Back" })).toBeTruthy();
    } else {
      expect((await screen.findAllByText("File processing")).length).toBeGreaterThan(0);
    }
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
    expect(
      document.querySelector('[data-slot="sidebar-wrapper"]')?.className.split(/\s+/u)
    ).toContain("h-svh");
    expect(document.querySelector('[data-slot="sidebar-inset"]')?.className).toContain("min-h-0");
    expect(
      document.querySelector('[data-slot="knowledge-base-detail-content"]')?.className
    ).toContain("min-h-0");
  });

  it("keeps the generated file title after following an internal evidence link", async () => {
    await openDetail();

    fireEvent.click(await screen.findByRole("button", { name: "intro.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generated page" }));

    await waitFor(() => {
      expect(fetchKnowledgeBaseFileDetail).toHaveBeenLastCalledWith({
        knowledgeBaseId: "kb-docs",
        path: "pages/intro.md"
      });
    });
    expect(screen.getByText("Intro", { selector: '[data-slot="card-title"]' })).toBeTruthy();
    expect(screen.queryByText("Generated page", { selector: '[data-slot="card-title"]' })).toBeNull();
  });

  it("exposes source-file editing actions from the file tree menu", async () => {
    await openDetail();

    fireEvent.pointerDown(await screen.findByRole("button", { name: "File actions: intro.md" }), {
      button: 0,
      ctrlKey: false
    });

    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Move" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Replace content" })).toBeTruthy();
  });

  it("shows a source detail service failure instead of a not-found editor state", async () => {
    vi.mocked(fetchSourceFile).mockRejectedValueOnce(
      new Error("errors.serviceUnavailable")
    );
    await openDetail();

    fireEvent.pointerDown(await screen.findByRole("button", { name: "File actions: intro.md" }), {
      button: 0,
      ctrlKey: false
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    expect(await screen.findByText("The service is temporarily unavailable")).toBeTruthy();
    expect(screen.queryByText("The requested resource was not found")).toBeNull();
  });

  it("searches the file tree and renders ancestor folders", async () => {
    await openDetail();

    fireEvent.change(screen.getByPlaceholderText("Search files and folders"), {
      target: {
        value: "intro"
      }
    });

    await waitFor(() => {
      expect(searchKnowledgeBaseFileTree).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        query: "intro",
        cursor: null
      });
    });
    expect(await screen.findByRole("button", { name: "pages" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "intro.md" })).toBeTruthy();
    expect(fetchKnowledgeBaseFileTree).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-docs",
      cursor: null
    });
  });

  it("resizes the detail sidebar within desktop bounds", async () => {
    await openDetail();

    const resizeHandle = await screen.findByRole("separator", { name: "Resize sidebar" });

    expect(resizeHandle.getAttribute("aria-valuemin")).toBe("256");
    expect(resizeHandle.getAttribute("aria-valuemax")).toBe("512");
    expect(resizeHandle.getAttribute("aria-valuenow")).toBe("256");
    expect(resizeHandle.getAttribute("data-sidebar")).toBe("rail");
    expect((resizeHandle as HTMLElement).style.left).toBe("");
    expect(resizeHandle.className).toContain("group-data-[side=left]:right-0");
    expect(resizeHandle.childElementCount).toBe(0);

    const sidebar = resizeHandle.closest('[data-slot="sidebar"]');
    const sidebarGap = sidebar?.querySelector('[data-slot="sidebar-gap"]');
    const sidebarContainer = sidebar?.querySelector('[data-slot="sidebar-container"]');

    expect(sidebar?.getAttribute("data-resizing")).toBe("false");
    expect(sidebarGap?.className).not.toContain("transition-none");
    expect(sidebarContainer?.className).not.toContain("transition-none");

    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      clientX: 0,
      pointerId: 1
    });
    await waitFor(() => {
      expect(sidebar?.getAttribute("data-resizing")).toBe("true");
      expect(sidebarGap?.className).toContain("transition-none");
      expect(sidebarContainer?.className).toContain("transition-none");
      expect((sidebarGap as HTMLElement | null)?.style.transitionProperty).toBe("none");
      expect((sidebarGap as HTMLElement | null)?.style.transitionDuration).toBe("0ms");
      expect((sidebarContainer as HTMLElement | null)?.style.transitionProperty).toBe("none");
      expect((sidebarContainer as HTMLElement | null)?.style.transitionDuration).toBe("0ms");
    });
    fireEvent.pointerMove(resizeHandle, {
      clientX: 400,
      pointerId: 1
    });
    expect(resizeHandle.getAttribute("aria-valuenow")).toBe("512");
    fireEvent.pointerUp(resizeHandle, {
      pointerId: 1
    });
    await waitFor(() => {
      expect(sidebar?.getAttribute("data-resizing")).toBe("false");
      expect(sidebarGap?.className).not.toContain("transition-none");
      expect(sidebarContainer?.className).not.toContain("transition-none");
      expect((sidebarGap as HTMLElement | null)?.style.transitionProperty).toBe("");
      expect((sidebarGap as HTMLElement | null)?.style.transitionDuration).toBe("");
      expect((sidebarContainer as HTMLElement | null)?.style.transitionProperty).toBe("");
      expect((sidebarContainer as HTMLElement | null)?.style.transitionDuration).toBe("");
    });

    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      clientX: 400,
      pointerId: 2
    });
    fireEvent.pointerMove(resizeHandle, {
      clientX: -400,
      pointerId: 2
    });
    expect(resizeHandle.getAttribute("aria-valuenow")).toBe("256");
    fireEvent.pointerUp(resizeHandle, {
      pointerId: 2
    });
  });

  it("keeps the detail sidebar resize handle off mobile viewports", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 500
    });

    await openDetail({ expectSidebarBackButton: false });

    await waitFor(() => {
      expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull();
    });
  });

  it("closes the mobile detail sidebar after selecting a primary destination", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390
    });

    await openDetail({ expectSidebarBackButton: false });
    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(await screen.findByRole("dialog", { name: "Sidebar" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull();
      expect(screen.getByRole("heading", { name: "Index maintenance" })).toBeTruthy();
    });
  });

  it("lets long file tree labels use the available sidebar row width", async () => {
    const longName =
      "a-very-long-generated-markdown-file-name-with-date-status-and-source-id.md";

    vi.mocked(fetchKnowledgeBaseFileTree).mockResolvedValueOnce({
      items: [
        {
          id: "tree-long",
          name: longName,
          logicalPath: `pages/${longName}`,
          entryType: "file",
          generatedFileId: "file-long",
          sourceFileId: "source-long",
          fileKind: "page",
          deletable: true
        }
      ],
      nextCursor: null
    });

    await openDetail();

    const fileButton = await screen.findByRole("button", { name: longName });
    const label = within(fileButton).getByText(longName);

    expect(fileButton.className).toContain("flex-1");
    expect(fileButton.className).toContain("min-w-0");
    expect(label.className).toContain("flex-1");
    expect(label.className).toContain("truncate");
    expect(label.getAttribute("title")).toBe(longName);

    const resizeHandle = screen.getByRole("separator", { name: "Resize sidebar" });

    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      clientX: 0,
      pointerId: 1
    });
    fireEvent.pointerMove(resizeHandle, {
      clientX: 120,
      pointerId: 1
    });
    fireEvent.pointerUp(resizeHandle, {
      pointerId: 1
    });

    expect(label.textContent).toBe(longName);
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
    expect(within(table).getByText("Processing")).toBeTruthy();
    expect(within(table).getByText("Waiting")).toBeTruthy();
    expect(within(table).getAllByText("Prepare")).toHaveLength(2);
    expect(within(table).getAllByText("Pending").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
    const panel = screen.getByTestId("source-file-progress-panel");
    const content = panel.querySelector('[data-slot="card-content"]');
    expect(panel.className).toContain("h-full");
    expect(panel.className).toContain("min-h-0");
    expect(content?.className).toContain("min-h-0");
    expect(content?.className).toContain("overflow-y-auto");
  });

  it("renders only the four document lifecycle summary cards", async () => {
    vi.mocked(fetchKnowledgeBaseProcessingSummary).mockResolvedValue({
      waitingCount: 5,
      processingCount: 3,
      availableCount: 8,
      errorCount: 1,
      oldestWaitingAt: "2026-07-20T00:00:00.000Z"
    });

    await openDetail();

    expect((await screen.findAllByText("Waiting")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Processing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Available").length).toBeGreaterThan(0);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText("Publication queue")).toBeNull();
    expect(screen.queryByText("Active generation")).toBeNull();
  });

  it("requests index maintenance from the knowledge-base settings view", async () => {
    await openDetail();

    const settingsButton = screen.getByRole("button", { name: "Settings" });
    fireEvent.click(settingsButton);
    await waitFor(() => {
      expect(settingsButton.getAttribute("data-active")).toBe("true");
    });
    expect(await screen.findByRole("heading", { name: "Index maintenance" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    const primarySetting = screen.getByText("Knowledge base indexes");
    const maintenanceRequirement = screen.getByText("Maintenance requirement");
    expect(
      primarySetting.compareDocumentPosition(maintenanceRequirement)
      & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getByText("Maintenance required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Maintain index" }));
    const dialog = screen.getByRole("alertdialog", {
      name: "Maintain this knowledge base?"
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start maintenance" }));

    await waitFor(() => {
      expect(requestKnowledgeBaseIndexMaintenance).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        idempotencyKey: expect.any(String)
      });
    });
    expect(await screen.findByText("Maintenance started")).toBeTruthy();
  });

  it("cancels maintenance while the server reports active work", async () => {
    const currentMaintenance = await vi.mocked(fetchKnowledgeBaseIndexMaintenance)({
      knowledgeBaseId: "kb-docs"
    });
    vi.mocked(fetchKnowledgeBaseIndexMaintenance).mockResolvedValue({
        ...currentMaintenance,
        requestId: "index-maintenance-active",
        state: "running",
        trigger: "automatic",
        stage: "projection:tree",
        active: true,
        completedCount: 20,
        expectedCount: 100
    });
    await openDetail();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const button = await screen.findByRole("button", { name: "Cancel maintenance" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("20 / 100")).toBeTruthy();
    expect(screen.getByText("Updating file navigation and relationships")).toBeTruthy();

    fireEvent.click(button);
    const dialog = screen.getByRole("alertdialog", { name: "Cancel this maintenance run?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel maintenance" }));

    await waitFor(() => {
      expect(cancelKnowledgeBaseIndexMaintenance).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs"
      });
    });
    expect(await screen.findByText("Maintenance cancelled")).toBeTruthy();
  });

  it("shows when index maintenance is not required", async () => {
    const currentMaintenance = await vi.mocked(fetchKnowledgeBaseIndexMaintenance)({
      knowledgeBaseId: "kb-docs"
    });
    vi.mocked(fetchKnowledgeBaseIndexMaintenance).mockResolvedValue({
      ...currentMaintenance,
      maintenanceRequired: false
    });
    await openDetail();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Up to date")).toBeTruthy();
  });

  it("deletes only selected eligible task rows from the current page", async () => {
    await openDetail();

    const runningCheckbox = (await screen.findByLabelText("Select intro.md")) as HTMLButtonElement;
    const queuedCheckbox = screen.getByLabelText("Select setup.md") as HTMLButtonElement;

    expect(runningCheckbox.disabled).toBe(true);
    expect(queuedCheckbox.disabled).toBe(false);
    fireEvent.click(screen.getByLabelText("Select eligible rows on this page"));
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete processing tasks" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete tasks" }));

    await waitFor(() => {
      expect(deleteKnowledgeBaseSourceFileTasks).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        sourceFileIds: ["source-002"]
      });
      expect(screen.getByText("Tasks deleted")).toBeTruthy();
    });
    expect(deleteKnowledgeBaseSourceFileTasks).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-slot="toast-viewport"]')).toHaveLength(1);
  });

  it("shows task deletion backend failures through the global toast", async () => {
    vi.mocked(deleteKnowledgeBaseSourceFileTasks).mockResolvedValueOnce({
      messageKey: "errors.sourceFileTaskDeletionInvalid"
    });

    await openDetail();

    fireEvent.click(await screen.findByLabelText("Select setup.md"));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "Delete processing tasks" })).getByRole(
        "button",
        { name: "Delete tasks" }
      )
    );

    expect(await screen.findByText("Task deletion failed")).toBeTruthy();
    expect(await screen.findByText("Task deletion request is invalid")).toBeTruthy();
    expect(screen.getByRole("alertdialog", { name: "Delete processing tasks" })).toBeTruthy();
  });

  it("opens a generated file directly from a completed source-file row", async () => {
    vi.mocked(listSourceFiles).mockResolvedValue({
      items: [
        {
          id: "source-001",
          name: "intro.md",
          relativePath: "intro.md",
          state: "available",
          blockingWorkKind: null,
          requiredWorkCount: 8,
          completedWorkCount: 8,
          activeWorkKinds: [],
          retryingWorkKind: null,
          failure: null,
          actions: [
            {
              kind: "open_generated_file",
              method: "GET",
              href: "/admin/api/knowledge-bases/kb-docs/files/content?path=pages%2Fintro.md",
              scope: "source_file"
            }
          ],
          processingStartedAt: "2026-06-14T00:00:00.000Z",
          processingEndedAt: "2026-06-14T00:00:10.000Z",
          modelInvocationStatus: "completed",
          modelInvocationModelName: "audit-model",
          modelInvocationStartedAt: "2026-06-14T00:00:02.000Z",
          modelInvocationEndedAt: "2026-06-14T00:00:07.000Z",
          modelInvocationWarningCount: 1,
          modelInvocationErrorCode: null,
          generatedFileAvailable: true,
          generatedFileId: "file-001",
          generatedFilePath: "pages/intro.md",
          createdAt: "2026-06-14T00:00:00.000Z"
        }
      ],
      nextCursor: null
    });

    await openDetail();

    const row = await screen.findByTestId("source-file-row-source-001");
    expect(within(row).getAllByText("Available")).toHaveLength(3);
    expect(within(row).getByText("audit-model / Completed / 5.0s / 1 warning")).toBeTruthy();
    expect(within(row).getByText("No error")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Open file" }));

    await waitFor(() => {
      expect(fetchKnowledgeBaseFileDetail).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        path: "pages/intro.md"
      });
    });
  });

  it("labels previous generated output and every generated-output filter truthfully", async () => {
    vi.mocked(listSourceFiles).mockResolvedValue({
      items: [{
        id: "source-previous",
        name: "guide.md",
        relativePath: "guide.md",
        state: "error",
        blockingWorkKind: null,
        requiredWorkCount: 8,
        completedWorkCount: 0,
        activeWorkKinds: [],
        retryingWorkKind: null,
        failure: {
          workKind: "activate",
          code: "DOCUMENT_FINALIZATION_FAILED",
          message: "Document finalization failed.",
          occurredAt: "2026-06-14T00:00:10.000Z",
          retryKind: "document_processing",
          correlationId: "document-job-previous"
        },
        actions: [],
        generatedFileAvailable: true,
        generatedOutputStatus: "previous_available",
        generatedFileId: "source-previous",
        generatedFilePath: "pages/guide.md",
        processingStartedAt: "2026-06-14T00:00:00.000Z",
        processingEndedAt: "2026-06-14T00:00:10.000Z",
        createdAt: "2026-06-14T00:00:00.000Z"
      }],
      nextCursor: null
    });

    await openDetail();

    expect(await screen.findByText("Previous version available")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", {
      name: "Filter Generated file"
    }));
    expect(await screen.findByRole("menuitemradio", {
      name: "Previous version available"
    })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Available" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Unavailable" })).toBeTruthy();
  });

  it("renders every fixed document work kind with the existing task-table layout", async () => {
    const workKinds = [
      ["prepare", "Prepare"],
      ["first_layer", "First-layer generation"],
      ["content_projection", "Content projection"],
      ["graphrag", "GraphRAG"],
      ["relation_reconcile", "Relationship reconciliation"],
      ["knowledge_projection", "Knowledge projection"],
      ["activate", "Activation"],
      ["cleanup", "Cleanup"]
    ] as const;
    vi.mocked(listSourceFiles).mockResolvedValue({
      items: workKinds.map(([blockingWorkKind], index) => ({
        id: `source-semantic-stage-${index}`,
        name: `stage-${index}.md`,
        relativePath: `stage-${index}.md`,
        state: "processing" as const,
        blockingWorkKind,
        requiredWorkCount: 8,
        completedWorkCount: index,
        activeWorkKinds: [blockingWorkKind],
        retryingWorkKind: null,
        failure: null,
        actions: [],
        generatedOutputStatus: "unavailable" as const,
        createdAt: "2026-06-14T00:00:00.000Z"
      })),
      nextCursor: null
    });

    await openDetail();

    for (const [, label] of workKinds) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
    expect(screen.getAllByTestId(/^source-file-row-/u)).toHaveLength(workKinds.length);

    const i18n = await initI18n("zh-CN");
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("tasks.workKind.prepare")).toBe("准备");
    expect(i18n.t("tasks.workKind.firstLayer")).toBe("前置模型处理");
    expect(i18n.t("tasks.workKind.contentProjection")).toBe("内容投影");
    expect(i18n.t("tasks.workKind.activate")).toBe("生效");
  });

  it("shows document failures with details and the backend-authorized retry action", async () => {
    vi.mocked(fetchKnowledgeBaseFileTree).mockResolvedValueOnce({
      items: [],
      nextCursor: null
    });
    vi.mocked(listSourceFiles).mockResolvedValueOnce({
      items: [
        {
          id: "source-failed",
          name: "broken.md",
          relativePath: "broken.md",
          state: "error",
          blockingWorkKind: null,
          requiredWorkCount: 8,
          completedWorkCount: 0,
          activeWorkKinds: [],
          retryingWorkKind: null,
          failure: {
            workKind: "activate",
            code: "DOCUMENT_FINALIZATION_FAILED",
            message: "Document finalization failed.",
            occurredAt: "2026-06-14T00:00:10.000Z",
            retryKind: "document_processing",
            correlationId: "document-job-001"
          },
          actions: [
            {
              kind: "view_failure_details",
              method: null,
              href: null,
              scope: "source_file"
            },
            {
              kind: "retry_document_processing",
              method: "POST",
              href: "/admin/api/knowledge-bases/kb-docs/source-files/source-failed/retry",
              scope: "source_file"
            }
          ],
          processingStartedAt: "2026-06-14T00:00:00.000Z",
          processingEndedAt: "2026-06-14T00:00:10.000Z",
          generatedFileAvailable: false,
          generatedOutputStatus: "unavailable",
          generatedFileId: null,
          generatedFilePath: null,
          createdAt: "2026-06-14T00:00:00.000Z"
        }
      ],
      nextCursor: null
    });

    await openDetail();

    expect(screen.queryByRole("button", { name: "broken.md" })).toBeNull();
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("DOCUMENT_FINALIZATION_FAILED")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry processing" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View failure details" }));
    expect(await screen.findByRole("dialog", { name: "Failure details" })).toBeTruthy();
    expect(screen.getByText("Document finalization failed.")).toBeTruthy();
    expect(screen.getByText("document-job-001")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
  });

  it("renders previous and next source-file pagination without load-more", async () => {
    vi.mocked(listSourceFiles)
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-001",
            name: "intro.md",
            relativePath: "intro.md",
            state: "available",
            blockingWorkKind: null,
            requiredWorkCount: 8,
            completedWorkCount: 8,
            activeWorkKinds: [],
            retryingWorkKind: null,
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: "2026-06-14T00:00:10.000Z",
            failure: null,
            actions: [],
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: "source-cursor-001"
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-002",
            name: "setup.md",
            relativePath: "setup.md",
            state: "available",
            blockingWorkKind: null,
            requiredWorkCount: 8,
            completedWorkCount: 8,
            activeWorkKinds: [],
            retryingWorkKind: null,
            processingStartedAt: "2026-06-14T00:00:11.000Z",
            processingEndedAt: "2026-06-14T00:00:20.000Z",
            failure: null,
            actions: [],
            createdAt: "2026-06-14T00:00:11.000Z"
          }
        ],
        nextCursor: null
      });

    await openDetail();

    const table = screen.getByRole("table", { name: "File processing" });
    expect(within(table).getByText("intro.md")).toBeTruthy();
    expect(within(table).queryByText("setup.md")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.getByText("Page 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(await within(table).findByText("setup.md")).toBeTruthy();
    expect(within(table).queryByText("intro.md")).toBeNull();
    expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(
      false
    );
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.getByText("Page 2")).toBeTruthy();
    expect(listSourceFiles).toHaveBeenNthCalledWith(1, {
      knowledgeBaseId: "kb-docs",
      cursor: null
    });
    expect(listSourceFiles).toHaveBeenNthCalledWith(2, {
      knowledgeBaseId: "kb-docs",
      cursor: "source-cursor-001"
    });
  });

  it("filters source files from table headers and resets cursor pagination", async () => {
    vi.mocked(listSourceFiles)
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-001",
            name: "intro.md",
            relativePath: "intro.md",
            state: "available",
            blockingWorkKind: null,
            requiredWorkCount: 8,
            completedWorkCount: 8,
            activeWorkKinds: [],
            retryingWorkKind: null,
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: "2026-06-14T00:00:10.000Z",
            failure: null,
            actions: [],
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: "source-cursor-001"
      })
      .mockResolvedValueOnce({
        items: [],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-001",
            name: "intro.md",
            relativePath: "intro.md",
            state: "available",
            blockingWorkKind: null,
            requiredWorkCount: 8,
            completedWorkCount: 8,
            activeWorkKinds: [],
            retryingWorkKind: null,
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: "2026-06-14T00:00:10.000Z",
            failure: null,
            actions: [],
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: "source-cursor-001"
      });

    await openDetail();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter File name" }));
    fireEvent.change(await screen.findByLabelText("File name"), {
      target: {
        value: "missing"
      }
    });

    await waitFor(() => {
      expect(listSourceFiles).toHaveBeenLastCalledWith({
        knowledgeBaseId: "kb-docs",
        cursor: null,
        filters: expect.objectContaining({
          fileNameQuery: "missing"
        })
      });
    });
    expect(await screen.findByText("No files match the current filters")).toBeTruthy();
    expect(screen.getByText("1 active filter")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Clear" }));

    await waitFor(() => {
      expect(listSourceFiles).toHaveBeenLastCalledWith({
        knowledgeBaseId: "kb-docs",
        cursor: null
      });
    });
  });

  it("forwards started and ended time filters from their table headers", async () => {
    await openDetail();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter Started" }));
    fireEvent.change(await screen.findByLabelText("From"), {
      target: { value: "2026-06-14T00:00" }
    });

    await waitFor(() => {
      expect(listSourceFiles).toHaveBeenLastCalledWith({
        knowledgeBaseId: "kb-docs",
        cursor: null,
        filters: expect.objectContaining({
          startedFrom: new Date("2026-06-14T00:00").toISOString()
        })
      });
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear" }));

    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter Ended" }));
    fireEvent.change(await screen.findByLabelText("To"), {
      target: { value: "2026-06-15T00:00" }
    });

    await waitFor(() => {
      expect(listSourceFiles).toHaveBeenLastCalledWith({
        knowledgeBaseId: "kb-docs",
        cursor: null,
        filters: expect.objectContaining({
          endedTo: new Date("2026-06-15T00:00").toISOString()
        })
      });
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

  it("clears the previous body when the next file detail cannot be loaded", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: "intro.md" }));
    expect(await screen.findByRole("heading", { name: "Intro", level: 1 })).toBeTruthy();

    vi.mocked(fetchKnowledgeBaseFileDetail).mockRejectedValueOnce(
      new Error("errors.serviceUnavailable")
    );
    fireEvent.click(screen.getByRole("button", { name: "Generated page" }));

    expect(await screen.findByText("The service is temporarily unavailable")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Intro", level: 1 })).toBeNull();
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
        "https://kb.example.com/openapi/v2/knowledge-bases/kb-docs/files/content?path=pages%2Fintro.md"
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
            generatedFileId: "file-001"
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
            generatedFileId: "file-002"
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

  it("reloads the previous known source-file page without appending rows", async () => {
    vi.mocked(listSourceFiles)
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-001",
            name: "intro.md",
            relativePath: "intro.md",
            state: "processing",
            blockingWorkKind: "prepare",
            requiredWorkCount: 8,
            completedWorkCount: 1,
            activeWorkKinds: ["prepare"],
            retryingWorkKind: null,
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: null,
            failure: null,
            actions: [],
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: "source-cursor-001"
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-002",
            name: "setup.md",
            relativePath: "setup.md",
            state: "available",
            blockingWorkKind: null,
            requiredWorkCount: 8,
            completedWorkCount: 8,
            activeWorkKinds: [],
            retryingWorkKind: null,
            processingStartedAt: "2026-06-13T00:00:00.000Z",
            processingEndedAt: "2026-06-13T00:00:10.000Z",
            failure: null,
            actions: [],
            createdAt: "2026-06-13T00:00:00.000Z"
          }
        ],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "source-001",
            name: "intro.md",
            relativePath: "intro.md",
            state: "processing",
            blockingWorkKind: "prepare",
            requiredWorkCount: 8,
            completedWorkCount: 1,
            activeWorkKinds: ["prepare"],
            retryingWorkKind: null,
            processingStartedAt: "2026-06-14T00:00:00.000Z",
            processingEndedAt: null,
            failure: null,
            actions: [],
            createdAt: "2026-06-14T00:00:00.000Z"
          }
        ],
        nextCursor: "source-cursor-001"
      });

    await openDetail();
    expect(await screen.findByTestId("source-file-row-source-001")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(await screen.findByTestId("source-file-row-source-002")).toBeTruthy();
    expect(screen.queryByTestId("source-file-row-source-001")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));

    expect(await screen.findByTestId("source-file-row-source-001")).toBeTruthy();
    expect(screen.queryByTestId("source-file-row-source-002")).toBeNull();
    expect(listSourceFiles).toHaveBeenNthCalledWith(1, {
      knowledgeBaseId: "kb-docs",
      cursor: null
    });
    expect(listSourceFiles).toHaveBeenNthCalledWith(2, {
      knowledgeBaseId: "kb-docs",
      cursor: "source-cursor-001"
    });
    expect(listSourceFiles).toHaveBeenNthCalledWith(3, {
      knowledgeBaseId: "kb-docs",
      cursor: null
    });
  });

  it("deletes a source-backed page from the file tree row menu", async () => {
    vi.mocked(listSourceFiles).mockResolvedValue({
        items: [
          {
            id: "source-001",
            name: "intro.md",
            relativePath: "intro.md",
            state: "available",
            blockingWorkKind: null,
            requiredWorkCount: 8,
            completedWorkCount: 8,
            activeWorkKinds: [],
            retryingWorkKind: null,
            processingStartedAt: "2026-06-14T00:00:03.000Z",
            processingEndedAt: "2026-06-14T00:00:04.000Z",
            failure: null,
            actions: [],
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
      expect(adminFetch).toHaveBeenCalledWith(
        "/admin/api/knowledge-bases/kb-docs/source-files/source-001",
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({ "if-match": "2" })
        })
      );
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

  it("deletes a stale file-tree search result with the latest resource revision", async () => {
    vi.mocked(searchKnowledgeBaseFileTree).mockResolvedValue({
      items: [
        {
          entry: {
            id: "tree-001",
            name: "intro.md",
            logicalPath: "pages/intro.md",
            entryType: "file",
            generatedFileId: "file-001",
            sourceFileId: "source-001",
            resourceRevision: 2,
            fileKind: "page",
            deletable: true
          },
          ancestors: [
            {
              id: "tree-pages",
              name: "pages",
              logicalPath: "pages",
              entryType: "directory",
              generatedFileId: null,
              sourceFileId: null,
              fileKind: null,
              deletable: false
            }
          ]
        }
      ],
      nextCursor: null
    });
    vi.mocked(fetchSourceFile).mockResolvedValueOnce({
      id: "source-001",
      name: "intro.md",
      relativePath: "intro.md",
      resourceRevision: 5,
      state: "available",
      blockingWorkKind: null,
      requiredWorkCount: 8,
      completedWorkCount: 8,
      activeWorkKinds: [],
      retryingWorkKind: null,
      failure: null,
      actions: [],
      createdAt: "2026-06-14T00:00:00.000Z"
    });

    await openDetail();
    fireEvent.change(screen.getByPlaceholderText("Search files and folders"), {
      target: { value: "intro" }
    });
    await waitFor(() => expect(searchKnowledgeBaseFileTree).toHaveBeenCalledTimes(1));

    fireEvent.pointerDown(await screen.findByRole("button", { name: "File actions: intro.md" }), {
      button: 0,
      ctrlKey: false
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "Delete Markdown file" }))
        .getByRole("button", { name: "Delete" })
    );

    await waitFor(() => {
      expect(adminFetch).toHaveBeenCalledWith(
        "/admin/api/knowledge-bases/kb-docs/source-files/source-001",
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({ "if-match": "5" })
        })
      );
      expect(searchKnowledgeBaseFileTree).toHaveBeenCalledTimes(2);
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
          generatedFileId: "file-index",
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

  it("deletes a source directory through its tree action", async () => {
    vi.mocked(fetchKnowledgeBaseFileTree).mockResolvedValueOnce({
      items: [
        {
          id: "tree-handbook",
          name: "handbook",
          logicalPath: "pages/handbook",
          entryType: "directory",
          generatedFileId: null,
          sourceFileId: null,
          fileKind: null,
          directEntryCount: 2,
          directDirectoryCount: 0,
          directFileCount: 2,
          sourceDirectoryId: "source-directory-handbook",
          resourceRevision: 3,
          descendantFileCount: 2,
          deletable: true
        }
      ],
      nextCursor: null
    });

    await openDetail();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Directory actions: handbook" }),
      { button: 0, ctrlKey: false }
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete directory" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete source directory" });
    expect(within(dialog).getByText(/2 source files/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteKnowledgeBaseSourceDirectory).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-docs",
        sourceDirectoryId: "source-directory-handbook",
        expectedResourceRevision: 3
      });
      expect(screen.getByText("Directory deletion accepted")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "handbook" })).toBeNull();
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
            generatedFileId: null
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
            generatedFileId: "file-001"
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

  it("refreshes an already loaded directory when it is reopened", async () => {
    vi.mocked(fetchKnowledgeBaseFileTree)
      .mockResolvedValueOnce({
        items: [{
          id: "tree-pages",
          name: "pages",
          logicalPath: "pages",
          entryType: "directory",
          generatedFileId: null
        }],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [{
          id: "tree-intro",
          name: "intro.md",
          logicalPath: "pages/intro.md",
          entryType: "file",
          generatedFileId: "file-intro"
        }],
        nextCursor: null
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "tree-intro",
            name: "intro.md",
            logicalPath: "pages/intro.md",
            entryType: "file",
            generatedFileId: "file-intro"
          },
          {
            id: "tree-new",
            name: "new.md",
            logicalPath: "pages/new.md",
            entryType: "file",
            generatedFileId: "file-new"
          }
        ],
        nextCursor: null
      });

    await openDetail();
    const pages = await screen.findByRole("button", { name: "pages" });
    fireEvent.click(pages);
    expect(await screen.findByRole("button", { name: "intro.md" })).toBeTruthy();
    fireEvent.click(pages);
    fireEvent.click(pages);

    expect(await screen.findByRole("button", { name: "new.md" })).toBeTruthy();
    expect(fetchKnowledgeBaseFileTree).toHaveBeenNthCalledWith(3, {
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
  });
});
