import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../src/components/settings-panel";
import { initI18n } from "../src/i18n";
import {
  createRuntimeModel,
  deleteRuntimeModel,
  fetchRuntimeSettings,
  updateMaintenanceSettings,
  updatePublicationSettings,
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
        sourceObjectReadConcurrency: 2,
        claimBatchSize: 10,
        pollIntervalMs: 1000,
        lockTtlSeconds: 900,
        heartbeatIntervalMs: 15000,
        jobMaxAttempts: 3,
        jobRetryDelayMs: 30000,
        completedJobRetentionDays: 7,
        hardDeleteConcurrency: 1,
        hardDeleteDatabaseBatchSize: 1000,
        hardDeleteObjectBatchSize: 1000,
        hardDeleteMaxAttempts: 3,
        hardDeleteRetryDelayMs: 60000
      },
      publication: {
        mode: "batch",
        intervalSeconds: 300,
        roleConcurrency: 1,
        claimBatchSize: 1,
        generatedObjectWriteConcurrency: 8,
        directoryIndexMaxEntries: 200,
        directoryIndexMaxBytes: 65536
      },
      graph: {
        candidateLimit: 200,
        acceptedEdgeLimit: 40,
        searchDefaultDepth: 1,
        searchMaxDepth: 2,
        searchDefaultFanout: 10,
        searchMaxFanout: 25,
        modelReviewEnabled: true,
        genericPhraseThreshold: 4
      },
      maintenance: {
        knowledgeBaseMaintenanceMode: "manual",
        knowledgeBaseMaintenanceScanIntervalSeconds: 21600,
        knowledgeBaseMaintenanceConcurrency: 1,
        reconciliationEnabled: true,
        scanBatchSize: 500,
        deletionBatchSize: 100,
        quarantineGracePeriodSeconds: 86400,
        maxAttempts: 5,
        retryDelayMs: 30000,
        projectionRepairConcurrency: 4,
        projectionRepairDatabaseBatchSize: 2000,
        projectionRepairObjectWriteConcurrency: 8,
        lexicalRebuildConcurrency: 4,
        lexicalRebuildSourceReadConcurrency: 8,
        lexicalRebuildMaxInFlightSourceBytes: 67_108_864
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
        stagingRetentionHours: 24,
        cropLength: 1200
      },
      semantic: {
        maximumChunkCharacters: 16000,
        maximumChunks: 32,
        maximumEvidenceTargets: 64,
        maximumCommunityPartitions: 256,
        maximumCommunityEntities: 10000,
        maximumCommunityRelationships: 20000,
        maximumCommunityBoundaryRelationships: 10000,
        maximumCommunitySummaryCharacters: 8000,
        communityAdapterTimeoutMs: 30000,
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
    maintenanceStatus: {
      state: "scanning",
      lastScanStartedAt: "2026-07-27T10:00:00.000Z",
      lastScanCompletedAt: "2026-07-27T09:00:00.000Z",
      listedCount: 500,
      quarantinedCount: 2,
      deletedCount: 1,
      missingCount: 0,
      retryCount: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
      resolvedCount: 3,
      pendingCount: 4,
      databaseChunkSize: 100,
      recentObjectsPerSecond: 50.1234,
      rollingBatchLatencyMs: 20,
      heartbeatAt: "2099-07-27T10:00:00.000Z",
      lastProgressAt: "2099-07-27T10:00:00.000Z"
    },
    objectProtectionStatus: {
      readiness: "backfilling",
      phase: "source_files",
      processedCount: 400,
      expectedCount: 1_000,
      verifiedCount: 0,
      dirtyCount: 3,
      retryCount: 0,
      recentObjectsPerSecond: 80,
      rollingBatchLatencyMs: 25,
      lastProgressAt: "2099-07-27T10:00:00.000Z",
      heartbeatAt: "2099-07-27T10:00:01.000Z",
      estimatedCompletionAt: "2099-07-27T10:01:00.000Z",
      lastErrorCode: null,
      lastErrorMessage: null
    }
  })),
  pauseRuntimeModel: vi.fn(),
  resumeRuntimeModel: vi.fn(),
  updatePublicationSettings: vi.fn(async (value) => ({ settings: {
    ...(await (fetchRuntimeSettings as unknown as () => Promise<any>)()).settings,
    publication: value
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

describe("SettingsPanel", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));
  });

  it("loads runtime settings and confirms model deletion", async () => {
    render(<SettingsPanel />);

    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
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

  it("keeps the released settings page shell while removing only approved fields", async () => {
    const { container } = render(<SettingsPanel />);

    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "API limits",
      "Worker",
      "Publication",
      "Graph",
      "Maintenance",
      "Search",
      "Semantic",
      "Embeddings",
      "Rerankers",
      "Models"
    ]);
    expect(container.querySelector("section.flex.min-w-0.flex-col.gap-6")).toBeTruthy();
    expect(container.querySelector(".max-w-full.overflow-x-auto [role='tablist']")).toBeTruthy();

    for (const tabName of ["Worker", "Publication", "Maintenance", "Search"]) {
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
    const automaticInterval = document.getElementById(
      "maintenance-knowledgeBaseMaintenanceScanIntervalSeconds"
    ) as HTMLInputElement;
    const knowledgeBaseConcurrency = document.getElementById(
      "maintenance-knowledgeBaseMaintenanceConcurrency"
    ) as HTMLInputElement;
    expect(scanBatchSize?.value).toBe("500");
    expect(automaticInterval?.value).toBe("21600");
    expect(automaticInterval?.disabled).toBe(true);
    expect(knowledgeBaseConcurrency?.value).toBe("1");
    const repairConcurrency = document.getElementById(
      "maintenance-projectionRepairConcurrency"
    ) as HTMLInputElement;
    const repairBatchSize = document.getElementById(
      "maintenance-projectionRepairDatabaseBatchSize"
    ) as HTMLInputElement;
    const repairObjectWrites = document.getElementById(
      "maintenance-projectionRepairObjectWriteConcurrency"
    ) as HTMLInputElement;
    const lexicalConcurrency = document.getElementById(
      "maintenance-lexicalRebuildConcurrency"
    ) as HTMLInputElement;
    const lexicalSourceReads = document.getElementById(
      "maintenance-lexicalRebuildSourceReadConcurrency"
    ) as HTMLInputElement;
    const lexicalInFlightBytes = document.getElementById(
      "maintenance-lexicalRebuildMaxInFlightSourceBytes"
    ) as HTMLInputElement;
    expect(repairConcurrency?.value).toBe("4");
    expect(repairBatchSize?.value).toBe("2000");
    expect(repairObjectWrites?.value).toBe("8");
    expect(lexicalConcurrency?.value).toBe("4");
    expect(lexicalSourceReads?.value).toBe("8");
    expect(lexicalInFlightBytes?.value).toBe("67108864");
    expect(document.getElementById("maintenance-projectionRepairWorkerPoolMax")).toBeNull();
    expect(document.getElementById("maintenance-lexicalRebuildWorkerPoolMax")).toBeNull();
    expect(screen.getByText(/Larger pages also create more bounded database chunks/)).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Source file protection")).toBeTruthy();
    expect(screen.getByText(/Objects resolved/)).toBeTruthy();
    expect(screen.getByText(/Pending candidates/)).toBeTruthy();
    expect(screen.getByText(/Database chunk size/)).toBeTruthy();
    expect(screen.getByText(/Protection verified/)).toBeTruthy();
    expect(screen.getByText(/Reconciliation heartbeat/)).toBeTruthy();
    expect(screen.getByText(/Estimated completion/)).toBeTruthy();
    expect(screen.getByText("50.1")).toBeTruthy();

    fireEvent.change(scanBatchSize, { target: { value: "600" } });
    fireEvent.change(knowledgeBaseConcurrency, { target: { value: "2" } });
    fireEvent.click(document.getElementById("maintenance-reconciliationEnabled")!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateMaintenanceSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeBaseMaintenanceMode: "manual",
          knowledgeBaseMaintenanceScanIntervalSeconds: 21600,
          knowledgeBaseMaintenanceConcurrency: 2,
          reconciliationEnabled: false,
          scanBatchSize: 600,
          projectionRepairConcurrency: 4,
          projectionRepairDatabaseBatchSize: 2000,
          projectionRepairObjectWriteConcurrency: 8,
          lexicalRebuildConcurrency: 4,
          lexicalRebuildSourceReadConcurrency: 8,
          lexicalRebuildMaxInFlightSourceBytes: 67_108_864
        })
      );
    });
  });

  it("shows model required-field feedback only after an invalid submit", async () => {
    render(<SettingsPanel />);

    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
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

  it("shows and saves bounded search settings", async () => {
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
    const stagingRetentionHours = document.getElementById(
      "search-stagingRetentionHours"
    ) as HTMLInputElement;
    const cropLength = document.getElementById(
      "search-cropLength"
    ) as HTMLInputElement;
    expect(requestTimeout.value).toBe("3000");
    expect(engineCutoff.value).toBe("1000");
    expect(inFlightTasks.value).toBe("8");
    expect(overfetchFactor.value).toBe("3");
    expect(stagingRetentionHours.value).toBe("24");
    expect(cropLength.value).toBe("1200");
    expect(screen.getByText(/Maximum end-to-end time for one search request/)).toBeTruthy();

    fireEvent.change(requestTimeout, { target: { value: "4000" } });
    fireEvent.change(engineCutoff, { target: { value: "1200" } });
    fireEvent.change(inFlightTasks, { target: { value: "6" } });
    fireEvent.change(overfetchFactor, { target: { value: "4" } });
    fireEvent.change(stagingRetentionHours, { target: { value: "48" } });
    fireEvent.change(cropLength, { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateSearchSettings).toHaveBeenCalledWith(expect.objectContaining({
        requestTimeoutMs: 4000,
        engineSearchCutoffMs: 1200,
        maxInFlightTasks: 6,
        overfetchFactor: 4,
        stagingRetentionHours: 48,
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
      maximumCommunityPartitions: 256,
      maximumCommunityEntities: 10000,
      maximumCommunityRelationships: 20000,
      maximumCommunityBoundaryRelationships: 10000,
      maximumCommunitySummaryCharacters: 8000,
      communityAdapterTimeoutMs: 30000,
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

  it("saves live source worker concurrency settings", async () => {
    render(<SettingsPanel />);
    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
    activateTab(screen.getByRole("tab", { name: "Worker" }));

    const sourceObjectReads = document.getElementById(
      "worker-sourceObjectReadConcurrency"
    ) as HTMLInputElement;
    fireEvent.change(sourceObjectReads, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateWorkerSettings).toHaveBeenCalledWith(expect.objectContaining({
        sourceFileConcurrency: 2,
        sourceObjectReadConcurrency: 1
      }));
    });
  });

  it("saves live publication object-write concurrency", async () => {
    render(<SettingsPanel />);
    expect(await screen.findByRole("tab", { name: "API limits" })).toBeTruthy();
    activateTab(screen.getByRole("tab", { name: "Publication" }));

    const objectWriteConcurrency = await waitFor(() => {
      const input = document.getElementById(
        "publication-generatedObjectWriteConcurrency"
      ) as HTMLInputElement | null;
      if (!input) {
        throw new Error("Expected publication object-write concurrency input.");
      }
      return input;
    });
    fireEvent.change(objectWriteConcurrency, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updatePublicationSettings).toHaveBeenCalledWith(expect.objectContaining({
        roleConcurrency: 1,
        generatedObjectWriteConcurrency: 7
      }));
    });
  });
});

function activateTab(tab: HTMLElement) {
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.pointerUp(tab);
  fireEvent.click(tab);
}
