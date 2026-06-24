import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { initI18n } from "../src/i18n";
import {
  checkAdminSession,
  createKnowledgeBase,
  createPublicOpenApiKey,
  deleteKnowledgeBase,
  deletePublicOpenApiKey,
  listKnowledgeBases,
  listPublicOpenApiKeys,
  loginAdmin,
  setAdminAuthFailureHandler
} from "../src/lib/admin-api";

vi.mock("../src/lib/admin-api", () => ({
  checkAdminSession: vi.fn(async () => false),
  createKnowledgeBase: vi.fn(async () => ({
    knowledgeBase: {
      id: "kb-created",
      name: "Created docs",
      description: "Created from the home page",
      activeReleaseId: null
    }
  })),
  createPublicOpenApiKey: vi.fn(async () => ({
    key: {
      id: "openapi-key-created",
      name: "Agent key",
      fingerprint: "fwok_cre...secret",
      status: "active",
      createdAt: "2026-06-14T00:00:00.000Z",
      lastUsedAt: null
    },
    oneTimeKey: {
      id: "openapi-key-created",
      rawKey: "fwok_created-secret"
    }
  })),
  deleteKnowledgeBase: vi.fn(async () => ({ deleted: true })),
  deletePublicOpenApiKey: vi.fn(async () => ({ deleted: true })),
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
    items: [],
    nextCursor: null
  })),
  listPublicOpenApiKeys: vi.fn(async () => ({
    items: [
      {
        id: "openapi-key-default",
        name: "Default key",
        fingerprint: "fwok_def...secret",
        status: "active",
        createdAt: "2026-06-14T00:00:00.000Z",
        lastUsedAt: null
      }
    ],
    nextCursor: null,
    oneTimeKey: {
      id: "openapi-key-default",
      rawKey: "fwok_default-secret"
    }
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

describe("Admin knowledge base home", () => {
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

  async function login() {
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

    await waitFor(() => {
      expect(loginAdmin).toHaveBeenCalledWith({ username: "admin", password: "admin-secret" });
    });
  }

  it("renders the focused empty home with create action and no upload panel", async () => {
    render(<App />);

    await login();

    expect(await screen.findByRole("heading", { name: "Knowledge bases", level: 1 })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Create knowledge base" }).length).toBeGreaterThan(
      0
    );
    expect(screen.getByText("No knowledge bases yet")).toBeTruthy();
    expect(screen.queryByText("Markdown sources")).toBeNull();
    expect(listKnowledgeBases).toHaveBeenCalledWith({});
  });

  it("restores an existing admin session without showing the login form", async () => {
    vi.mocked(checkAdminSession).mockResolvedValueOnce(true);
    vi.mocked(listKnowledgeBases).mockResolvedValueOnce({
      items: [
        {
          id: "kb-docs",
          name: "Developer docs",
          description: "Markdown product knowledge",
          activeReleaseId: null
        }
      ],
      nextCursor: null
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Knowledge bases", level: 1 })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Developer docs" })).toBeTruthy();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(loginAdmin).not.toHaveBeenCalled();
  });

  it("clears protected home content when the admin session becomes invalid", async () => {
    vi.mocked(checkAdminSession).mockResolvedValueOnce(true);
    vi.mocked(listKnowledgeBases).mockResolvedValueOnce({
      items: [
        {
          id: "kb-docs",
          name: "Developer docs",
          description: "Markdown product knowledge",
          activeReleaseId: null
        }
      ],
      nextCursor: null
    });

    render(<App />);

    expect(await screen.findByRole("button", { name: "Developer docs" })).toBeTruthy();
    const handler = vi.mocked(setAdminAuthFailureHandler).mock.calls[0]?.[0];

    await act(async () => {
      handler?.();
    });

    expect(await screen.findByLabelText("Username")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Developer docs" })).toBeNull();
  });

  it("opens the create dialog and appends the created knowledge base card", async () => {
    render(<App />);

    await login();
    const createButtons = await screen.findAllByRole("button", { name: "Create knowledge base" });
    expect(createButtons.length).toBeGreaterThan(0);
    fireEvent.click(createButtons[0] as HTMLElement);

    expect(screen.getByRole("dialog", { name: "Create knowledge base" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Knowledge base name"), {
      target: {
        value: "Created docs"
      }
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: {
        value: "Created from the home page"
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createKnowledgeBase).toHaveBeenCalledWith({
        name: "Created docs",
        description: "Created from the home page"
      });
    });
    expect(await screen.findByRole("button", { name: "Created docs" })).toBeTruthy();
  });

  it("navigates from a knowledge base card to the detail page", async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValueOnce({
      items: [
        {
          id: "kb-docs",
          name: "Developer docs",
          description: "Markdown product knowledge",
          activeReleaseId: null
        }
      ],
      nextCursor: null
    });
    render(<App />);

    await login();
    const knowledgeBaseCardButton = await screen.findByRole("button", { name: "Developer docs" });
    expect(knowledgeBaseCardButton.textContent).toBe("");
    fireEvent.click(knowledgeBaseCardButton);

    expect(await screen.findByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getAllByText("Developer docs").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "File processing" }).getAttribute("data-active")).toBe(
      "true"
    );
    expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
    expect(screen.queryByText("No file selected")).toBeNull();
  });

  it("shows knowledge base IDs on cards and copies them without opening the card", async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValueOnce({
      items: [
        {
          id: "kb-docs",
          name: "Developer docs",
          description: "Markdown product knowledge",
          activeReleaseId: null
        }
      ],
      nextCursor: null
    });
    render(<App />);

    await login();

    const cardButton = await screen.findByRole("button", { name: "Developer docs" });
    expect(screen.getByText("Markdown product knowledge")).toBeTruthy();
    expect(screen.getByText("Knowledge base ID")).toBeTruthy();
    expect(screen.getByText("kb-docs")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Knowledge base actions for Developer docs" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy knowledge base ID kb-docs" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("kb-docs");
    });
    expect(await screen.findByText("Copied")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    fireEvent.click(cardButton);
    expect(await screen.findByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("switches home page language from the page controls", async () => {
    render(<App />);

    await login();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Language" }), {
      button: 0,
      ctrlKey: false
    });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Chinese" }));

    expect(await screen.findByRole("heading", { name: "知识库", level: 1 })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "创建知识库" }).length).toBeGreaterThan(0);
  });

  it("manages public OpenAPI keys from the home tabs", async () => {
    render(<App />);

    await login();
    const openApiKeysTab = screen.getByRole("tab", { name: "OpenAPI keys" });
    fireEvent.mouseDown(openApiKeysTab, {
      button: 0,
      ctrlKey: false
    });
    fireEvent.mouseUp(openApiKeysTab);
    fireEvent.click(openApiKeysTab);

    expect(await screen.findByText("Default key")).toBeTruthy();
    expect(await screen.findByRole("dialog", { name: "Copy this key now" })).toBeTruthy();
    expect(screen.getByDisplayValue("fwok_default-secret")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByDisplayValue("fwok_default-secret")).toBeNull();
    });
    expect(listPublicOpenApiKeys).toHaveBeenCalledWith({});

    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    fireEvent.change(screen.getByLabelText("Key name"), {
      target: {
        value: "Agent key"
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createPublicOpenApiKey).toHaveBeenCalledWith({ name: "Agent key" });
    });
    expect(await screen.findByText("Agent key")).toBeTruthy();
    expect(await screen.findByRole("dialog", { name: "Copy this key now" })).toBeTruthy();
    expect(screen.getByDisplayValue("fwok_created-secret")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByDisplayValue("fwok_created-secret")).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete Agent key" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deletePublicOpenApiKey).toHaveBeenCalledWith({ keyId: "openapi-key-created" });
    });
    await waitFor(() => {
      expect(screen.queryByText("Agent key")).toBeNull();
    });
    expect(screen.queryByText("Revoked")).toBeNull();
  });

  it("appends paginated knowledge base card pages", async () => {
    vi.mocked(listKnowledgeBases)
      .mockResolvedValueOnce({
        items: [
          {
            id: "kb-one",
            name: "One docs",
            description: null,
            activeReleaseId: null
          }
        ],
        nextCursor: "cursor-one"
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "kb-two",
            name: "Two docs",
            description: null,
            activeReleaseId: null
          }
        ],
        nextCursor: null
      });
    render(<App />);

    await login();
    expect(await screen.findByRole("button", { name: "One docs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("button", { name: "Two docs" })).toBeTruthy();
    expect(listKnowledgeBases).toHaveBeenNthCalledWith(1, {});
    expect(listKnowledgeBases).toHaveBeenNthCalledWith(2, { cursor: "cursor-one" });
  });

  it("deletes a knowledge base from the card menu without opening the card", async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValueOnce({
      items: [
        {
          id: "kb-docs",
          name: "Developer docs",
          description: "Markdown product knowledge",
          activeReleaseId: null
        }
      ],
      nextCursor: null
    });
    render(<App />);

    await login();
    fireEvent.pointerDown(
      await screen.findByRole("button", {
        name: "Knowledge base actions for Developer docs"
      }),
      {
        button: 0,
        ctrlKey: false
      }
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(screen.getByRole("alertdialog", { name: "Delete knowledge base" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteKnowledgeBase).toHaveBeenCalledWith({ knowledgeBaseId: "kb-docs" });
      expect(screen.queryByRole("button", { name: "Developer docs" })).toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});
