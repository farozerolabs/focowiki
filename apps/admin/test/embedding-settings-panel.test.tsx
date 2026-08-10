import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingSettingsPanel } from
  "../src/components/embedding-settings-panel";
import { initI18n } from "../src/i18n";
import {
  activateEmbeddingConfiguration,
  createEmbeddingConfiguration,
  deleteEmbeddingConfiguration,
  fetchEmbeddingConfigurations,
  pauseEmbeddingConfiguration,
  resumeEmbeddingConfiguration,
  testEmbeddingConfiguration,
  updateEmbeddingConfiguration
} from "@/lib/admin-api";

vi.mock("@/lib/admin-api", () => ({
  fetchEmbeddingConfigurations: vi.fn(),
  createEmbeddingConfiguration: vi.fn(),
  updateEmbeddingConfiguration: vi.fn(),
  testEmbeddingConfiguration: vi.fn(),
  activateEmbeddingConfiguration: vi.fn(),
  pauseEmbeddingConfiguration: vi.fn(),
  resumeEmbeddingConfiguration: vi.fn(),
  deleteEmbeddingConfiguration: vi.fn()
}));

describe("EmbeddingSettingsPanel", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));
    vi.mocked(fetchEmbeddingConfigurations).mockResolvedValue({
      configurations: [configuration()]
    });
    vi.mocked(createEmbeddingConfiguration).mockResolvedValue({
      configuration: configuration()
    });
    vi.mocked(updateEmbeddingConfiguration).mockResolvedValue({
      configuration: configuration()
    });
    vi.mocked(testEmbeddingConfiguration).mockResolvedValue({
      configuration: configuration()
    });
    vi.mocked(activateEmbeddingConfiguration).mockResolvedValue({
      configuration: configuration()
    });
    vi.mocked(pauseEmbeddingConfiguration).mockResolvedValue({
      configuration: { ...configuration(), lifecycleStatus: "paused" }
    });
    vi.mocked(resumeEmbeddingConfiguration).mockResolvedValue({
      configuration: { ...configuration(), lifecycleStatus: "draft" }
    });
    vi.mocked(deleteEmbeddingConfiguration).mockResolvedValue({ deleted: true });
  });

  it("shows every safe field without rendering credentials", async () => {
    const { container } = render(<EmbeddingSettingsPanel />);
    expect(await screen.findByText("Primary embedding")).toBeTruthy();
    for (const value of [
      "https://embedding.example/v1", "embedding-model", "1536", "8192",
      "32", "30000", "2", "0", "4", "8388608"
    ]) expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    expect(screen.getByText("Configured")).toBeTruthy();
    expect(container.textContent).not.toContain("embedding-secret");
    expect(container.textContent).not.toContain("encryptedApiKey");
  });

  it("creates a configuration with every field and supports unauthenticated local endpoints", async () => {
    render(<EmbeddingSettingsPanel />);
    await screen.findByText("Primary embedding");
    fireEvent.click(screen.getByRole("button", { name: "Add embedding model" }));
    expect(screen.getByText(
      "Only set this when the provider supports custom dimensions. If the test fails, leave it blank and use the resolved dimension."
    )).toBeTruthy();

    change("embedding-displayName", "Local embedding");
    change("embedding-baseUrl", "http://embedding:8080/v1");
    change("embedding-modelName", "local-model");
    change("embedding-requestedDimension", "768");
    change("embedding-maximumInputTokens", "4096");
    change("embedding-batchSize", "16");
    change("embedding-timeoutMs", "20000");
    change("embedding-retryCount", "1");
    change("embedding-minimumIntervalMs", "10");
    change("embedding-concurrency", "2");
    change("embedding-maximumResponseBytes", "1048576");
    chooseSelect("embedding-authenticationMode", "No authentication");
    fireEvent.click(screen.getByRole("button", { name: "Create embedding model" }));

    await waitFor(() => expect(createEmbeddingConfiguration).toHaveBeenCalledWith({
      displayName: "Local embedding",
      authenticationMode: "none",
      baseUrl: "http://embedding:8080/v1",
      apiKey: null,
      modelName: "local-model",
      requestedDimension: 768,
      normalization: "l2",
      maximumInputTokens: 4096,
      batchSize: 16,
      timeoutMs: 20000,
      retryCount: 1,
      minimumIntervalMs: 10,
      concurrency: 2,
      maximumResponseBytes: 1048576,
      minimumVectorRelevance: 0.7
    }));
  });

  it("tests and applies lifecycle actions with optimistic revisions", async () => {
    render(<EmbeddingSettingsPanel />);
    await screen.findByText("Primary embedding");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(testEmbeddingConfiguration).toHaveBeenCalledWith("embedding-config-a");
      expect(pauseEmbeddingConfiguration).toHaveBeenCalledWith(
        "embedding-config-a", 2
      );
    });
  });

  it("updates every editable field while retaining an existing redacted secret", async () => {
    render(<EmbeddingSettingsPanel />);
    await screen.findByText("Primary embedding");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    change("embedding-displayName", "Updated embedding");
    change("embedding-requestedDimension", "768");
    change("embedding-maximumInputTokens", "4096");
    change("embedding-batchSize", "12");
    change("embedding-timeoutMs", "15000");
    change("embedding-retryCount", "1");
    change("embedding-minimumIntervalMs", "25");
    change("embedding-concurrency", "3");
    change("embedding-maximumResponseBytes", "2097152");
    chooseSelect("embedding-normalization", "None");
    fireEvent.click(screen.getByRole("button", { name: "Update embedding model" }));

    await waitFor(() => expect(updateEmbeddingConfiguration).toHaveBeenCalledWith({
      configurationId: "embedding-config-a",
      expectedRevision: 2,
      configuration: {
        displayName: "Updated embedding",
        authenticationMode: "api_key",
        baseUrl: "https://embedding.example/v1",
        apiKey: null,
        modelName: "embedding-model",
        requestedDimension: 768,
        normalization: "none",
        maximumInputTokens: 4096,
        batchSize: 12,
        timeoutMs: 15000,
        retryCount: 1,
        minimumIntervalMs: 25,
        concurrency: 3,
        maximumResponseBytes: 2097152,
        minimumVectorRelevance: 0.7
      }
    }));
  });

  it("supports resume, activate, delete, empty, loading, and safe error states", async () => {
    vi.mocked(fetchEmbeddingConfigurations).mockResolvedValueOnce({
      configurations: [{ ...configuration(), lifecycleStatus: "paused" }]
    });
    const { unmount } = render(<EmbeddingSettingsPanel />);
    await screen.findByText("Primary embedding");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resumeEmbeddingConfiguration).toHaveBeenCalledWith(
      "embedding-config-a", 2
    ));
    await screen.findByRole("button", { name: "Pause" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete embedding model" }));
    await waitFor(() => {
      expect(deleteEmbeddingConfiguration).toHaveBeenCalledWith(
        "embedding-config-a", 2
      );
    });
    unmount();

    vi.mocked(fetchEmbeddingConfigurations).mockResolvedValueOnce({
      configurations: [{ ...configuration(), lifecycleStatus: "draft" }]
    });
    const draft = render(<EmbeddingSettingsPanel />);
    await screen.findByText("Primary embedding");
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(activateEmbeddingConfiguration).toHaveBeenCalledWith(
      "embedding-config-a", 2
    ));
    draft.unmount();

    vi.mocked(fetchEmbeddingConfigurations).mockResolvedValueOnce({
      configurations: []
    });
    const empty = render(<EmbeddingSettingsPanel />);
    expect(await screen.findByText("No embedding models configured")).toBeTruthy();
    empty.unmount();

    vi.mocked(fetchEmbeddingConfigurations).mockResolvedValueOnce({
      messageKey: "errors.embeddingConfigurationUnavailable"
    });
    render(<EmbeddingSettingsPanel />);
    expect(screen.getByText("Loading settings")).toBeTruthy();
    expect(await screen.findByText("Embedding configuration is unavailable"))
      .toBeTruthy();
  });

  it("blocks invalid numeric input and displays safe action failures", async () => {
    vi.mocked(testEmbeddingConfiguration).mockResolvedValueOnce({
      messageKey: "errors.embeddingConfigurationAuthenticationFailed"
    });
    render(<EmbeddingSettingsPanel />);
    await screen.findByText("Primary embedding");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Embedding endpoint authentication failed"))
      .toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add embedding model" }));
    change("embedding-displayName", "Invalid embedding");
    change("embedding-modelName", "model");
    change("embedding-concurrency", "1.5");
    fireEvent.click(screen.getByRole("button", { name: "Create embedding model" }));
    expect(await screen.findByText(
      "Complete every required field with a value inside its allowed range."
    ))
      .toBeTruthy();
    expect(createEmbeddingConfiguration).not.toHaveBeenCalled();
  });

  it("keeps the embedding settings surface available in Chinese", async () => {
    await initI18n("zh-CN").then((i18n) => i18n.changeLanguage("zh-CN"));
    vi.mocked(fetchEmbeddingConfigurations).mockResolvedValueOnce({
      configurations: []
    });
    render(<EmbeddingSettingsPanel />);
    expect(await screen.findByText("暂无向量模型配置")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加向量模型" }));
    expect(screen.getByText(
      "仅在服务商支持自定义维度时填写；如果测试失败，建议留空，由系统使用模型返回的实际维度。"
    )).toBeTruthy();
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
    publicId: "embedding-config-a",
    revisionPublicId: "embedding-revision-a",
    revision: 2,
    displayName: "Primary embedding",
    authenticationMode: "api_key" as const,
    baseUrl: "https://embedding.example/v1",
    apiKeyConfigured: true,
    modelName: "embedding-model",
    requestedDimension: 1536,
    resolvedDimension: 1536,
    normalization: "l2" as const,
    maximumInputTokens: 8192,
    batchSize: 32,
    timeoutMs: 30000,
    retryCount: 2,
    minimumIntervalMs: 0,
    concurrency: 4,
    maximumResponseBytes: 8388608,
    minimumVectorRelevance: 0.7,
    vectorProducingRevisionPublicId: "embedding-revision-a",
    queryPolicyRevisionPublicId: "embedding-revision-a",
    validationStatus: "valid" as const,
    validationFingerprintSha256: "a".repeat(64),
    safeValidationErrorCode: null,
    lifecycleStatus: "active" as const,
    createdAt: "2026-08-08T00:00:00.000Z"
  };
}
