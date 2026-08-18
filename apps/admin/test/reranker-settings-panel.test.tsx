import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RerankerSettingsPanel } from
  "../src/components/reranker-settings-panel";
import { initI18n } from "../src/i18n";
import {
  activateRerankerConfiguration,
  createRerankerConfiguration,
  deleteRerankerConfiguration,
  fetchRerankerConfigurations,
  pauseRerankerConfiguration,
  resumeRerankerConfiguration,
  testRerankerConfiguration,
  updateRerankerConfiguration
} from "@/lib/admin-api";
import { showAdminToast } from "@/hooks/use-admin-toast";

vi.mock("@/lib/admin-api", () => ({
  fetchRerankerConfigurations: vi.fn(),
  createRerankerConfiguration: vi.fn(),
  updateRerankerConfiguration: vi.fn(),
  testRerankerConfiguration: vi.fn(),
  activateRerankerConfiguration: vi.fn(),
  pauseRerankerConfiguration: vi.fn(),
  resumeRerankerConfiguration: vi.fn(),
  deleteRerankerConfiguration: vi.fn()
}));
vi.mock("@/hooks/use-admin-toast", () => ({ showAdminToast: vi.fn() }));

describe("RerankerSettingsPanel", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));
    vi.mocked(fetchRerankerConfigurations).mockResolvedValue({
      configurations: [configuration()]
    });
    vi.mocked(createRerankerConfiguration).mockResolvedValue({
      configuration: configuration()
    });
    vi.mocked(updateRerankerConfiguration).mockResolvedValue({
      configuration: configuration()
    });
    vi.mocked(testRerankerConfiguration).mockResolvedValue({
      configuration: configuration()
    });
    vi.mocked(activateRerankerConfiguration).mockResolvedValue({
      configuration: configuration()
    });
    vi.mocked(pauseRerankerConfiguration).mockResolvedValue({
      configuration: { ...configuration(), lifecycleStatus: "paused" }
    });
    vi.mocked(resumeRerankerConfiguration).mockResolvedValue({
      configuration: { ...configuration(), lifecycleStatus: "draft" }
    });
    vi.mocked(deleteRerankerConfiguration).mockResolvedValue({ deleted: true });
  });

  it("shows every model field without credentials or request-ranking controls", async () => {
    const { container } = render(<RerankerSettingsPanel />);
    expect(await screen.findByText("Primary reranker")).toBeTruthy();
    for (const value of [
      "https://reranker.example/v1", "reranker-model",
      "30000", "2", "0", "4"
    ]) expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    expect(screen.getByText("Configured")).toBeTruthy();
    expect(container.textContent).not.toContain("reranker-secret");
    expect(container.textContent).not.toContain("rerankTopK");
    expect(container.textContent).not.toContain("rerankScoreThreshold");
    expect(container.textContent).not.toContain("source excerpt");
  });

  it("creates, tests, and pauses with every model-only field", async () => {
    render(<RerankerSettingsPanel />);
    await screen.findByText("Primary reranker");
    fireEvent.click(screen.getByRole("button", { name: "Add reranker model" }));
    expect((document.getElementById("reranker-baseUrl") as HTMLInputElement).value)
      .toBe("");
    expect(screen.getByText(/automatically appends \/rerank/u)).toBeTruthy();
    change("reranker-displayName", "Local reranker");
    change("reranker-baseUrl", "http://reranker:8080/v1");
    change("reranker-modelName", "local-reranker");
    change("reranker-timeoutMs", "20000");
    change("reranker-retryCount", "1");
    change("reranker-minimumIntervalMs", "10");
    change("reranker-concurrency", "2");
    chooseSelect("reranker-authenticationMode", "No authentication");
    fireEvent.click(screen.getByRole("button", { name: "Create reranker model" }));

    await waitFor(() => expect(createRerankerConfiguration).toHaveBeenCalledWith({
      displayName: "Local reranker",
      authenticationMode: "none",
      baseUrl: "http://reranker:8080/v1",
      apiKey: null,
      modelName: "local-reranker",
      timeoutMs: 20000,
      retryCount: 1,
      minimumIntervalMs: 10,
      concurrency: 2
    }));

    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(showAdminToast).toHaveBeenCalledWith({
      title: "Reranker model test succeeded"
    }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(testRerankerConfiguration).toHaveBeenCalledWith("reranker-config-a");
      expect(pauseRerankerConfiguration).toHaveBeenCalledWith(
        "reranker-config-a", 2
      );
    });
  });

  it("updates fields while retaining the redacted credential", async () => {
    render(<RerankerSettingsPanel />);
    await screen.findByText("Primary reranker");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    change("reranker-displayName", "Updated reranker");
    change("reranker-timeoutMs", "15000");
    change("reranker-retryCount", "1");
    change("reranker-minimumIntervalMs", "25");
    change("reranker-concurrency", "3");
    fireEvent.click(screen.getByRole("button", { name: "Update reranker model" }));

    await waitFor(() => expect(updateRerankerConfiguration).toHaveBeenCalledWith({
      configurationId: "reranker-config-a",
      expectedRevision: 2,
      configuration: {
        displayName: "Updated reranker",
        authenticationMode: "api_key",
        baseUrl: "https://reranker.example/v1",
        apiKey: null,
        modelName: "reranker-model",
        timeoutMs: 15000,
        retryCount: 1,
        minimumIntervalMs: 25,
        concurrency: 3
      }
    }));
  });

  it("supports resume, activate, delete, errors, and Chinese text", async () => {
    vi.mocked(fetchRerankerConfigurations).mockResolvedValueOnce({
      configurations: [{ ...configuration(), lifecycleStatus: "paused" }]
    });
    const paused = render(<RerankerSettingsPanel />);
    await screen.findByText("Primary reranker");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resumeRerankerConfiguration).toHaveBeenCalledWith(
      "reranker-config-a", 2
    ));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete reranker model" }));
    await waitFor(() => expect(deleteRerankerConfiguration).toHaveBeenCalledWith(
      "reranker-config-a", 2
    ));
    paused.unmount();

    vi.mocked(fetchRerankerConfigurations).mockResolvedValueOnce({
      configurations: [{ ...configuration(), lifecycleStatus: "draft" }]
    });
    const draft = render(<RerankerSettingsPanel />);
    await screen.findByText("Primary reranker");
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(activateRerankerConfiguration).toHaveBeenCalledWith(
      "reranker-config-a", 2
    ));
    draft.unmount();

    await initI18n("zh-CN").then((i18n) => i18n.changeLanguage("zh-CN"));
    vi.mocked(fetchRerankerConfigurations).mockResolvedValueOnce({
      configurations: []
    });
    render(<RerankerSettingsPanel />);
    expect(await screen.findByText("暂无重排模型配置")).toBeTruthy();
  });
});

function change(id: string, value: string) {
  fireEvent.change(document.getElementById(id)!, { target: { value } });
}

function chooseSelect(id: string, optionName: string) {
  const trigger = document.getElementById(id)!;
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

function configuration() {
  return {
    publicId: "reranker-config-a",
    revisionPublicId: "reranker-revision-a",
    revision: 2,
    displayName: "Primary reranker",
    authenticationMode: "api_key" as const,
    baseUrl: "https://reranker.example/v1",
    apiKeyConfigured: true,
    modelName: "reranker-model",
    timeoutMs: 30_000,
    retryCount: 2,
    minimumIntervalMs: 0,
    concurrency: 4,
    validationStatus: "valid" as const,
    validationFingerprintSha256: "a".repeat(64),
    safeValidationErrorCode: null,
    lifecycleStatus: "active" as const,
    createdAt: "2026-08-09T00:00:00.000Z"
  };
}
