import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../src/components/settings-panel";
import { initI18n } from "../src/i18n";
import {
  createRuntimeModel,
  deleteRuntimeModel,
  fetchRuntimeSettings,
  updateGeneratedSettings,
  updateMaintenanceSettings,
  updateRuntimeModel,
  updateRateLimitSettings,
  updateSearchSettings,
  updateSemanticSettings,
  updateWorkerSettings
} from "@/lib/admin-api";

class TestResizeObserver implements ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

globalThis.ResizeObserver = TestResizeObserver;

vi.mock("@/lib/admin-api", () => ({
  activateRuntimeModel: vi.fn(),
  createRuntimeModel: vi.fn(),
  updateRuntimeModel: vi.fn(async (modelId, value) => ({
    model: {
      id: modelId,
      ...value,
      apiKeyFingerprint: "key...test",
      status: "active",
      isActive: true,
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:01:00.000Z",
      lastUsedAt: null
    }
  })),
  deleteRuntimeModel: vi.fn(async () => ({
    model: {
      id: "model-001",
      displayName: "Primary model",
      apiMode: "responses",
      baseUrl: "https://api.openai.com/v1",
      modelName: "gpt-test",
      contextWindowTokens: 200000,
      requestMaxTimeoutMs: 600000,
      requestIdleTimeoutMs: 120000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 60000,
      requestMinIntervalMs: 1000,
      apiKeyFingerprint: "key...test",
      status: "deleted",
      isActive: false,
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
      lastUsedAt: null
    }
  })),
  fetchRuntimeSettings: vi.fn(async () => ({
    settings: {
      rateLimits: {
        adminLogin: { max: 8, windowSeconds: 900 },
        adminApi: { max: 600, windowSeconds: 60 },
        publicOpenApi: { max: 1200, windowSeconds: 60 }
      },
      worker: {
        sourceFileConcurrency: 2,
        s3Concurrency: 6,
        jobMaxAttempts: 3,
        jobRetryDelayMs: 30000,
        completedJobRetentionDays: 7
      },
      generated: {
        directoryIndexMaxEntries: 200,
        directoryIndexMaxBytes: 65536,
        rootSummaryLimit: 500,
        okfLogMaxEntries: 100,
        okfLogMaxBytes: 65536
      },
      graph: {
        candidateLimit: 200,
        acceptedEdgeLimit: 40,
        searchDefaultDepth: 1,
        searchMaxDepth: 2,
        searchDefaultFanout: 10,
        searchMaxFanout: 25,
        shardSize: 5000,
        genericPhraseThreshold: 4
      },
      maintenance: {
        reconciliationEnabled: true,
        scanBatchSize: 500,
        maxAttempts: 5,
        retryDelayMs: 30000,
        hardDeleteConcurrency: 1,
        hardDeleteDatabaseBatchSize: 1000,
        hardDeleteObjectBatchSize: 1000,
        hardDeleteMaxAttempts: 3,
        hardDeleteRetryDelayMs: 60_000,
        hardDeleteFailedRetentionDays: 30
      },
      search: {
        requestTimeoutMs: 3000,
        engineSearchCutoffMs: 1000,
        overfetchFactor: 3,
        indexBatchDocumentCount: 500,
        indexBatchCompressedBytes: 8_388_608,
        maxInFlightTasks: 8,
        taskPollIntervalMs: 500,
        taskTimeoutMs: 600_000,
        maxAttempts: 5,
        retryDelayMs: 2000,
        cleanupBatchSize: 1000,
        cropLength: 1200
      },
      semantic: {
        maximumChunkCharacters: 16000,
        maximumChunks: 32,
        maximumEvidenceTargets: 64,
        graphRagAdapterTimeoutMs: 30000,
        searchLaneCutoffMs: 1000,
        queryEmbeddingConcurrency: 4,
        queryEmbeddingCacheEntries: 1000
      },
      activeModel: {
        id: "model-001"
      }
    },
    models: [
      {
        id: "model-001",
        displayName: "Primary model",
        apiMode: "responses",
        baseUrl: "https://api.openai.com/v1",
        modelName: "gpt-test",
        contextWindowTokens: 200000,
        requestMaxTimeoutMs: 600000,
        requestIdleTimeoutMs: 120000,
        suggestionConcurrency: 2,
        transientRetryDelayMs: 60000,
        requestMinIntervalMs: 1000,
        apiKeyFingerprint: "key...test",
        status: "active",
        isActive: true,
        createdAt: "2026-06-14T00:00:00.000Z",
        updatedAt: "2026-06-14T00:00:00.000Z",
        lastUsedAt: null
      }
    ],
  })),
  pauseRuntimeModel: vi.fn(),
  resumeRuntimeModel: vi.fn(),
  updateGeneratedSettings: vi.fn(async (value) => ({ settings: {
    ...(await (fetchRuntimeSettings as unknown as () => Promise<any>)()).settings,
    generated: value
  } })),
  updateRateLimitSettings: vi.fn(),
  updateGraphSettings: vi.fn(),
  updateMaintenanceSettings: vi.fn(async (value) => ({ settings: {
    ...(await (fetchRuntimeSettings as unknown as () => Promise<any>)()).settings,
    maintenance: value
  } })),
  updateSearchSettings: vi.fn(async (value) => ({ settings: {
    ...(await (fetchRuntimeSettings as unknown as () => Promise<any>)()).settings,
    search: value
  } })),
  updateSemanticSettings: vi.fn(async (value) => ({ settings: {
    ...(await (fetchRuntimeSettings as unknown as () => Promise<any>)()).settings,
    semantic: value
  } })),
  updateWorkerSettings: vi.fn(async (value) => ({ settings: {
    ...(await (fetchRuntimeSettings as unknown as () => Promise<any>)()).settings,
    worker: value
  } }))
}));

vi.mock("@/components/embedding-settings-panel", () => ({
  EmbeddingSettingsPanel: () => <div>Embedding settings</div>
}));

vi.mock("@/components/reranker-settings-panel", () => ({
  RerankerSettingsPanel: () => <div>Reranker settings</div>
}));

describe("SettingsPanel", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));
  });

  it("loads runtime settings and confirms model deletion", async () => {
    render(<SettingsPanel section="models" />);

    expect(await screen.findByRole("tab", { name: "Models" })).toBeTruthy();
    const modelsTab = screen.getByRole("tab", { name: "Models" });
    fireEvent.pointerDown(modelsTab);
    fireEvent.mouseDown(modelsTab);
    fireEvent.pointerUp(modelsTab);
    fireEvent.click(modelsTab);
    expect(await screen.findByText("Primary model")).toBeTruthy();
    expect(screen.getByText("Responses API")).toBeTruthy();
    expect(screen.getByText("https://api.openai.com/v1")).toBeTruthy();
    expect(screen.getByText("key...test")).toBeTruthy();
    expect(screen.getByText("gpt-test")).toBeTruthy();
    for (const value of ["200000", "600000", "120000", "2", "60000", "1000"]) {
      expect(screen.getByText(value)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("alertdialog", { name: "Delete model" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete model" }));

    await waitFor(() => {
      expect(deleteRuntimeModel).toHaveBeenCalledWith("model-001");
    });
    expect(fetchRuntimeSettings).toHaveBeenCalled();
  });

  it("updates a generation model while leaving its credential input empty", async () => {
    render(<SettingsPanel section="models" />);

    expect(await screen.findByRole("tab", { name: "Models" })).toBeTruthy();
    activateTab(screen.getByRole("tab", { name: "Models" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    const displayName = document.getElementById("model-display-name") as HTMLInputElement;
    const apiKey = document.getElementById("model-api-key") as HTMLInputElement;
    expect(displayName.value).toBe("Primary model");
    expect(apiKey.value).toBe("");
    fireEvent.change(displayName, { target: { value: "Primary model updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Update model" }));

    await waitFor(() => {
      expect(updateRuntimeModel).toHaveBeenCalledWith(
        "model-001",
        expect.objectContaining({
          displayName: "Primary model updated",
          apiKey: ""
        })
      );
    });
  });

  it("keeps a newly created model inactive until the existing activate action is used", async () => {
    vi.mocked(createRuntimeModel).mockResolvedValue({
      model: {
        id: "model-review",
        displayName: "Review model",
        apiMode: "responses",
        baseUrl: "https://example.invalid/v1",
        modelName: "review-model",
        contextWindowTokens: 200000,
        requestMaxTimeoutMs: 600000,
        requestIdleTimeoutMs: 120000,
        suggestionConcurrency: 2,
        transientRetryDelayMs: 60000,
        requestMinIntervalMs: 2000,
        apiKeyFingerprint: "review",
        status: "active",
        isActive: false,
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
        deletedAt: null
      }
    });
    render(<SettingsPanel section="models" />);

    expect(await screen.findByRole("tab", { name: "Models" })).toBeTruthy();
    activateTab(screen.getByRole("tab", { name: "Models" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add model" }));

    fireEvent.change(document.getElementById("model-display-name")!, {
      target: { value: "Review model" }
    });
    fireEvent.change(document.getElementById("model-base-url")!, {
      target: { value: "https://example.invalid/v1" }
    });
    fireEvent.change(document.getElementById("model-api-key")!, {
      target: { value: "review-placeholder" }
    });
    fireEvent.change(document.getElementById("model-name")!, {
      target: { value: "review-model" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create model" }));

    await waitFor(() => {
      expect(createRuntimeModel).toHaveBeenCalledWith(expect.objectContaining({
        displayName: "Review model",
        isActive: false
      }));
    });
  });

  it("keeps the released settings page shell while removing only approved fields", async () => {
    const { container } = render(<SettingsPanel />);

    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "API limits",
      "Worker",
      "Generated knowledge base",
      "Graph",
      "Maintenance",
      "Search",
      "Semantic"
    ]);
    expect(container.querySelector("section.flex.min-w-0.flex-col.gap-6")).toBeTruthy();
    expect(container.querySelector(".max-w-full.overflow-x-auto [role='tablist']")).toBeTruthy();

    for (const tabName of ["Worker", "Generated knowledge base", "Maintenance", "Search"]) {
      activateTab(screen.getByRole("tab", { name: tabName }));
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: tabName }).getAttribute("data-state"))
          .toBe("active");
      });
      expect(container.querySelector(".grid.gap-4.md\\:grid-cols-2.xl\\:grid-cols-3"))
        .toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    }

    for (const id of [
      "worker-generationBatchSize",
      "worker-hardDeleteVersionPurgeEnabled",
      "publication-generationAssemblyConcurrency",
      "publication-generationRetentionDays",
      "maintenance-migrationBackfillConcurrency",
      "maintenance-lexicalRebuildDatabaseWriteConcurrency",
      "maintenance-lexicalRebuildClaimBatchSize",
      "maintenance-lexicalRebuildDatabaseBatchSize"
    ]) {
      expect(document.getElementById(id), id).toBeNull();
    }
  });

  it("keeps empty required number fields empty and blocks settings save", async () => {
    render(<SettingsPanel />);

    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
    const maxRequests = document.getElementById("adminLogin-max") as HTMLInputElement | null;
    expect(maxRequests).toBeTruthy();
    if (!maxRequests) {
      throw new Error("Expected admin login max requests input.");
    }
    fireEvent.change(maxRequests, { target: { value: "" } });
    expect(maxRequests.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateRateLimitSettings).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Required numeric fields must be positive integers.")
    ).toBeTruthy();
  });

  it("shows and saves bounded maintenance settings", async () => {
    render(<SettingsPanel />);

    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
    const maintenanceTab = screen.getByRole("tab", { name: "Maintenance" });
    fireEvent.pointerDown(maintenanceTab);
    fireEvent.mouseDown(maintenanceTab);
    fireEvent.pointerUp(maintenanceTab);
    fireEvent.click(maintenanceTab);
    await waitFor(() => {
      expect(maintenanceTab.getAttribute("data-state")).toBe("active");
    });
    const scanBatchSize = document.getElementById("maintenance-scanBatchSize") as HTMLInputElement;
    expect(scanBatchSize?.value).toBe("500");
    expect(document.getElementById(
      "maintenance-knowledgeBaseMaintenanceScanIntervalSeconds"
    )).toBeNull();
    expect(document.getElementById(
      "maintenance-knowledgeBaseMaintenanceConcurrency"
    )).toBeNull();
    expect(document.getElementById("maintenance-projectionRepairConcurrency")).toBeNull();
    expect(document.getElementById("maintenance-lexicalRebuildConcurrency")).toBeNull();
    expect(document.getElementById("maintenance-projectionRepairWorkerPoolMax")).toBeNull();
    expect(document.getElementById("maintenance-lexicalRebuildWorkerPoolMax")).toBeNull();
    expect(screen.getByText(/Larger pages also create more bounded database chunks/)).toBeTruthy();
    expect(screen.queryByText(/Objects resolved/)).toBeNull();
    expect(screen.queryByText(/Protection verified/)).toBeNull();

    fireEvent.change(scanBatchSize, { target: { value: "600" } });
    fireEvent.click(document.getElementById("maintenance-reconciliationEnabled")!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateMaintenanceSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          reconciliationEnabled: false,
          scanBatchSize: 600
        })
      );
    });
  });

  it("shows model required-field feedback only after an invalid submit", async () => {
    render(<SettingsPanel section="models" />);

    expect(await screen.findByRole("tab", { name: "Models" })).toBeTruthy();
    const modelsTab = screen.getByRole("tab", { name: "Models" });
    fireEvent.pointerDown(modelsTab);
    fireEvent.mouseDown(modelsTab);
    fireEvent.pointerUp(modelsTab);
    fireEvent.click(modelsTab);
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));

    expect(screen.queryByText("Model fields are required when creating a model.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create model" }));

    expect(
      await screen.findByText("Model fields are required when creating a model.")
    ).toBeTruthy();
    expect(createRuntimeModel).not.toHaveBeenCalled();
  });

  it("renders model configuration as a separate three-tab surface", async () => {
    render(<SettingsPanel section="models" />);

    expect(await screen.findByRole("tab", { name: "Models" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Embedding models",
      "Reranker models",
      "Models"
    ]);
    expect(screen.getByRole("tab", { name: "Embedding models" }).getAttribute("data-state"))
      .toBe("active");
    expect(screen.queryByRole("tab", { name: "API limits" })).toBeNull();
  });

  it("selects the first available tab when moving between settings surfaces", async () => {
    const view = render(<SettingsPanel section="models" />);

    expect(await screen.findByRole("tab", { name: "Embedding models" })).toBeTruthy();
    activateTab(screen.getByRole("tab", { name: "Models" }));
    expect(screen.getByRole("tab", { name: "Models" }).getAttribute("data-state"))
      .toBe("active");

    view.rerender(<SettingsPanel section="runtime" />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "API limits" }).getAttribute("data-state"))
        .toBe("active");
    });
    expect(screen.getByText("Update admin and OpenAPI request limits without restarting the service."))
      .toBeTruthy();
  });

  it("shows and saves configurable search concurrency", async () => {
    render(<SettingsPanel />);

    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
    activateTab(screen.getByRole("tab", { name: "Search" }));

    const requestTimeout = await waitFor(() => {
      const input = document.getElementById("search-requestTimeoutMs") as HTMLInputElement | null;
      if (!input) {
        throw new Error("Expected search request timeout input.");
      }
      return input;
    });
    const engineCutoff = document.getElementById(
      "search-engineSearchCutoffMs"
    ) as HTMLInputElement;
    const inFlightTasks = document.getElementById(
      "search-maxInFlightTasks"
    ) as HTMLInputElement;
    const overfetchFactor = document.getElementById(
      "search-overfetchFactor"
    ) as HTMLInputElement;
    const cropLength = document.getElementById(
      "search-cropLength"
    ) as HTMLInputElement;
    expect(requestTimeout.value).toBe("3000");
    expect(engineCutoff.value).toBe("1000");
    expect(inFlightTasks.value).toBe("8");
    expect(overfetchFactor.value).toBe("3");
    expect(document.getElementById("search-stagingRetentionHours")).toBeNull();
    expect(cropLength.value).toBe("1200");
    expect(screen.getByText("Search concurrency")).toBeTruthy();
    expect(screen.getByText(/Maximum end-to-end time for one search request/)).toBeTruthy();

    fireEvent.change(requestTimeout, { target: { value: "4000" } });
    fireEvent.change(engineCutoff, { target: { value: "1200" } });
    fireEvent.change(inFlightTasks, { target: { value: "128" } });
    fireEvent.change(overfetchFactor, { target: { value: "4" } });
    fireEvent.change(cropLength, { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateSearchSettings).toHaveBeenCalledWith(expect.objectContaining({
        requestTimeoutMs: 4000,
        engineSearchCutoffMs: 1200,
        maxInFlightTasks: 128,
        overfetchFactor: 4,
        cropLength: 1500,
        indexBatchDocumentCount: 500,
        indexBatchCompressedBytes: 8_388_608
      }));
    });
  });

  it("shows and saves every bounded semantic setting", async () => {
    render(<SettingsPanel />);
    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
    activateTab(screen.getByRole("tab", { name: "Semantic" }));

    for (const [field, value] of Object.entries({
      maximumChunkCharacters: 16000,
      maximumChunks: 32,
      maximumEvidenceTargets: 64,
      graphRagAdapterTimeoutMs: 30000,
      searchLaneCutoffMs: 1000,
      queryEmbeddingConcurrency: 4,
      queryEmbeddingCacheEntries: 1000
    })) {
      expect((document.getElementById(`semantic-${field}`) as HTMLInputElement).value)
        .toBe(String(value));
    }

    fireEvent.change(document.getElementById("semantic-queryEmbeddingConcurrency")!, {
      target: { value: "5" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(updateSemanticSettings).toHaveBeenCalledWith(expect.objectContaining({
        queryEmbeddingConcurrency: 5,
        maximumChunkCharacters: 16000,
        searchLaneCutoffMs: 1000
      }));
    });
  });

  it("removes upload admission controls from the settings surface", async () => {
    render(<SettingsPanel />);

    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Upload and generation" })).toBeNull();
    expect(document.getElementById("upload-generation-maxBytes")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Upload" })).toBeNull();
  });

  it("saves live document worker concurrency settings", async () => {
    render(<SettingsPanel />);
    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
    activateTab(screen.getByRole("tab", { name: "Worker" }));

    const maximumAttempts = document.getElementById(
      "worker-jobMaxAttempts"
    ) as HTMLInputElement;
    const s3Concurrency = document.getElementById(
      "worker-s3Concurrency"
    ) as HTMLInputElement;
    expect(s3Concurrency.value).toBe("6");
    fireEvent.change(s3Concurrency, { target: { value: "12" } });
    fireEvent.change(maximumAttempts, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateWorkerSettings).toHaveBeenCalledWith(expect.objectContaining({
        sourceFileConcurrency: 2,
        s3Concurrency: 12,
        jobMaxAttempts: 4
      }));
    });
  });

  it("saves generated knowledge-base directory limits without publication controls", async () => {
    render(<SettingsPanel />);
    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
    activateTab(screen.getByRole("tab", { name: "Generated knowledge base" }));

    const directoryLimit = await waitFor(() => {
      const input = document.getElementById(
        "generated-directoryIndexMaxEntries"
      ) as HTMLInputElement | null;
      if (!input) {
        throw new Error("Expected generated directory limit input.");
      }
      return input;
    });
    fireEvent.change(directoryLimit, { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateGeneratedSettings).toHaveBeenCalledWith(expect.objectContaining({
        directoryIndexMaxEntries: 250,
        directoryIndexMaxBytes: 65536,
        rootSummaryLimit: 500,
        okfLogMaxEntries: 100,
        okfLogMaxBytes: 65536
      }));
    });
    expect(document.getElementById("publication-mode")).toBeNull();
  });
});

function activateTab(tab: HTMLElement) {
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.pointerUp(tab);
  fireEvent.click(tab);
}
