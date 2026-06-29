import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/pages/SettingsPage";
import { initI18n } from "../src/i18n";
import {
  deleteRuntimeModel,
  fetchRuntimeSettings,
  updateRateLimitSettings,
  updateUploadGenerationSettings
} from "@/lib/admin-api";

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
        upload: { max: 20, windowSeconds: 3600 },
        publicOpenApi: { max: 1200, windowSeconds: 60 }
      },
      worker: {
        sourceFileConcurrency: 2,
        claimBatchSize: 10,
        pollIntervalMs: 1000,
        lockTtlSeconds: 900,
        heartbeatIntervalMs: 15000,
        jobMaxAttempts: 3,
        jobRetryDelayMs: 30000,
        queueBackpressureLimit: 5000,
        queueBackpressureKnowledgeBaseLimit: 2000,
        queueBackpressureMaxAgeSeconds: 3600,
        queueBackpressureRetryAfterSeconds: 60,
        shutdownGraceMs: 30000,
        completedJobRetentionDays: 7,
        failedJobRetentionDays: 30,
        deadLetterJobRetentionDays: 90,
        retentionCleanupBatchSize: 1000
      },
      publication: {
        mode: "batch",
        batchSize: 300,
        intervalSeconds: 300,
        indexShardSize: 1000,
        linkIndexShardSize: 1000,
        manifestShardSize: 1000,
        graphEdgeShardSize: 5000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500,
        okfLogMaxEntries: 100,
        okfLogMaxBytes: 65536
      },
      uploadGeneration: {
        maxBytes: 1048576,
        maxFiles: 24,
        generationBatchSize: 50,
        fileProcessingConcurrency: 1,
        storageConcurrency: 4
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
  updatePublicationSettings: vi.fn(),
  updateRateLimitSettings: vi.fn(),
  updateUploadGenerationSettings: vi.fn(async () => ({
    settings: {
      rateLimits: {
        adminLogin: { max: 8, windowSeconds: 900 },
        adminApi: { max: 600, windowSeconds: 60 },
        upload: { max: 20, windowSeconds: 3600 },
        publicOpenApi: { max: 1200, windowSeconds: 60 }
      },
      worker: {
        sourceFileConcurrency: 2,
        claimBatchSize: 10,
        pollIntervalMs: 1000,
        lockTtlSeconds: 900,
        heartbeatIntervalMs: 15000,
        jobMaxAttempts: 3,
        jobRetryDelayMs: 30000,
        queueBackpressureLimit: 5000,
        queueBackpressureKnowledgeBaseLimit: 2000,
        queueBackpressureMaxAgeSeconds: 3600,
        queueBackpressureRetryAfterSeconds: 60,
        shutdownGraceMs: 30000,
        completedJobRetentionDays: 7,
        failedJobRetentionDays: 30,
        deadLetterJobRetentionDays: 90,
        retentionCleanupBatchSize: 1000
      },
      publication: {
        mode: "batch",
        batchSize: 300,
        intervalSeconds: 300,
        indexShardSize: 1000,
        linkIndexShardSize: 1000,
        manifestShardSize: 1000,
        graphEdgeShardSize: 5000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500,
        okfLogMaxEntries: 100,
        okfLogMaxBytes: 65536
      },
      uploadGeneration: {
        maxBytes: 2097152,
        maxFiles: 12,
        generationBatchSize: 80,
        fileProcessingConcurrency: 1,
        storageConcurrency: 2
      },
      activeModel: {
        id: "model-001"
      }
    }
  })),
  updateWorkerSettings: vi.fn()
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

  it("edits upload-generation settings and blocks empty required fields", async () => {
    render(<SettingsPage onBack={vi.fn()} onLogout={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    const uploadTab = screen.getByRole("tab", { name: "Upload and generation" });
    fireEvent.pointerDown(uploadTab);
    fireEvent.mouseDown(uploadTab);
    fireEvent.pointerUp(uploadTab);
    fireEvent.click(uploadTab);

    await waitFor(() => {
      expect(screen.getAllByText("Upload and generation").length).toBeGreaterThan(0);
    });
    expect(
      screen.getByText("Maximum total bytes accepted by one upload request. Recommended: 10485760 for 10 MB, or lower for small deployments.")
    ).toBeTruthy();

    const maxBytes = document.getElementById(
      "upload-generation-maxBytes"
    ) as HTMLInputElement | null;
    const maxFiles = document.getElementById(
      "upload-generation-maxFiles"
    ) as HTMLInputElement | null;
    const batchSize = document.getElementById(
      "upload-generation-generationBatchSize"
    ) as HTMLInputElement | null;

    if (!maxBytes || !maxFiles || !batchSize) {
      throw new Error("Expected upload-generation inputs.");
    }

    fireEvent.change(maxBytes, { target: { value: "" } });
    expect(maxBytes.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateUploadGenerationSettings).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Required numeric fields must be positive integers.")
    ).toBeTruthy();

    fireEvent.change(maxBytes, { target: { value: "2097152" } });
    fireEvent.change(maxFiles, { target: { value: "12" } });
    fireEvent.change(batchSize, { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateUploadGenerationSettings).toHaveBeenCalledWith({
        maxBytes: 2_097_152,
        maxFiles: 12,
        generationBatchSize: 80,
        fileProcessingConcurrency: 1,
        storageConcurrency: 4
      });
    });
  });
});
