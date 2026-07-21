import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/pages/SettingsPage";
import { initI18n } from "../src/i18n";
import {
  createRuntimeModel,
  deleteRuntimeModel,
  fetchRuntimeSettings,
  updateMaintenanceSettings,
  updatePublicationSettings,
  updateRateLimitSettings,
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
        graphQueryConcurrency: 2,
        databaseMutationConcurrency: 2,
        claimBatchSize: 10,
        generationBatchSize: 50,
        pollIntervalMs: 1000,
        lockTtlSeconds: 900,
        heartbeatIntervalMs: 15000,
        jobMaxAttempts: 3,
        jobRetryDelayMs: 30000,
        sourceQueueHardDepth: 5000,
        sourceQueueResumeDepth: 3000,
        sourceQueueHardAgeSeconds: 3600,
        sourceQueueResumeAgeSeconds: 1800,
        shutdownGraceMs: 30000,
        completedJobRetentionDays: 7,
        failedJobRetentionDays: 30,
        deadLetterJobRetentionDays: 90,
        retentionCleanupBatchSize: 1000,
        hardDeleteConcurrency: 1,
        hardDeleteDatabaseBatchSize: 1000,
        hardDeleteObjectBatchSize: 1000,
        hardDeleteMaxAttempts: 3,
        hardDeleteRetryDelayMs: 60000,
        hardDeleteFailedRetentionDays: 30,
        hardDeleteVersionPurgeEnabled: false
      },
      publication: {
        mode: "batch",
        batchSize: 300,
        intervalSeconds: 300,
        roleConcurrency: 1,
        claimBatchSize: 1,
        impactBatchSize: 100,
        impactConcurrency: 8,
        generationAssemblyConcurrency: 1,
        projectionPartitionConcurrency: 8,
        generatedObjectWriteConcurrency: 8,
        directoryMaterializationConcurrency: 4,
        dirtyFileHardCount: 2000,
        dirtyFileResumeCount: 1000,
        dirtyAgeHardSeconds: 900,
        dirtyAgeResumeSeconds: 300,
        pendingImpactHardCount: 20000,
        pendingImpactResumeCount: 10000,
        generationRetentionDays: 7,
        indexShardSize: 1000,
        linkIndexShardSize: 1000,
        manifestShardSize: 1000,
        graphEdgeShardSize: 5000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500,
        directoryIndexMaxEntries: 200,
        directoryIndexMaxBytes: 65536,
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
        modelReviewEnabled: true,
        publicationShardSize: 5000,
        cacheTtlSeconds: 30,
        genericPhraseThreshold: 4
      },
      maintenance: {
        reconciliationEnabled: true,
        scanIntervalSeconds: 21600,
        scanBatchSize: 500,
        deletionBatchSize: 100,
        quarantineGracePeriodSeconds: 86400,
        confirmationPasses: 2,
        maxAttempts: 5,
        retryDelayMs: 30000,
        migrationBackfillConcurrency: 2,
        compactionConcurrency: 1
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
    ]
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
  updateWorkerSettings: vi.fn(async (value) => ({ settings: {
    ...(await (fetchRuntimeSettings as unknown as () => Promise<any>)()).settings,
    worker: value
  } }))
}));

describe("SettingsPage", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));
  });

  it("loads runtime settings and confirms model deletion", async () => {
    render(<SettingsPage onBack={vi.fn()} onLogout={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
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

  it("keeps empty required number fields empty and blocks settings save", async () => {
    render(<SettingsPage onBack={vi.fn()} onLogout={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
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
    render(<SettingsPage onBack={vi.fn()} onLogout={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
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
    expect(screen.getByText(/S3 page limit is 1,000 objects/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateMaintenanceSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          reconciliationEnabled: true,
          scanBatchSize: 500,
          confirmationPasses: 2
        })
      );
    });
  });

  it("shows model required-field feedback only after an invalid submit", async () => {
    render(<SettingsPage onBack={vi.fn()} onLogout={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
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

  it("removes upload admission controls from the settings surface", async () => {
    render(<SettingsPage onBack={vi.fn()} onLogout={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Upload and generation" })).toBeNull();
    expect(document.getElementById("upload-generation-maxBytes")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Upload" })).toBeNull();
  });

  it("saves source worker generation and hysteresis settings", async () => {
    render(<SettingsPage onBack={vi.fn()} onLogout={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    activateTab(screen.getByRole("tab", { name: "Worker" }));

    const generationBatchSize = await waitFor(() => {
      const input = document.getElementById("worker-generationBatchSize") as HTMLInputElement | null;
      if (!input) {
        throw new Error("Expected worker generation batch input.");
      }
      return input;
    });
    const resumeDepth = document.getElementById("worker-sourceQueueResumeDepth") as HTMLInputElement;
    fireEvent.change(generationBatchSize, { target: { value: "80" } });
    fireEvent.change(resumeDepth, { target: { value: "2500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateWorkerSettings).toHaveBeenCalledWith(expect.objectContaining({
        generationBatchSize: 80,
        sourceQueueHardDepth: 5000,
        sourceQueueResumeDepth: 2500
      }));
    });
  });

  it("saves publication pressure and bounded work settings", async () => {
    render(<SettingsPage onBack={vi.fn()} onLogout={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    activateTab(screen.getByRole("tab", { name: "Publication" }));

    const impactBatchSize = await waitFor(() => {
      const input = document.getElementById("publication-impactBatchSize") as HTMLInputElement | null;
      if (!input) {
        throw new Error("Expected publication impact batch input.");
      }
      return input;
    });
    fireEvent.change(impactBatchSize, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updatePublicationSettings).toHaveBeenCalledWith(expect.objectContaining({
        roleConcurrency: 1,
        impactBatchSize: 120,
        impactConcurrency: 8,
        dirtyFileHardCount: 2000,
        dirtyFileResumeCount: 1000,
        pendingImpactHardCount: 20000,
        pendingImpactResumeCount: 10000
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
