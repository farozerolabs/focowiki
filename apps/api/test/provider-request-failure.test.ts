import { describe, expect, it, vi } from "vitest";
import {
  providerFailureFromModelObservation,
  reportProviderFailureOnce,
  withProviderFailureReporting
} from "../src/semantic/provider-request-failure.js";

describe("provider request failure diagnostics", () => {
  it("reports generation SDK failures without request payloads", async () => {
    const failure = Object.assign(new Error(
      "Request rejected; api_key=provider-secret"
    ), {
      status: 422,
      request_id: "generation-sdk-request-123",
      type: "invalid_request_error",
      code: "invalid_input",
      param: "input"
    });
    const create = vi.fn().mockRejectedValue(failure);
    const reporter = vi.fn();
    const client = withProviderFailureReporting({
      apiMode: "responses",
      responses: { create }
    }, {
      apiMode: "responses",
      baseUrl: "https://generation.example/v1",
      modelName: "generation-model"
    }, reporter);

    if (client.apiMode === "chat_completions") {
      throw new Error("Unexpected client mode");
    }
    await expect(client.responses.create({} as never)).rejects.toBe(failure);
    expect(reporter).toHaveBeenCalledOnce();
    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({
      providerKind: "generation",
      providerHost: "generation.example",
      providerRoute: "/v1",
      httpStatusCode: 422,
      providerRequestId: "generation-sdk-request-123",
      providerErrorCode: "invalid_input",
      errorMessage: "Request rejected; api_key=<redacted>"
    }));
    expect(JSON.stringify(reporter.mock.calls)).not.toContain("provider-secret");
  });

  it("turns incomplete and invalid model responses into bounded diagnostics", () => {
    const diagnostic = providerFailureFromModelObservation({
      modelName: "generation-model"
    }, {
      apiMode: "chat_completions",
      structuredOutputCapability: "native_json_schema",
      attempt: 1,
      repair: false,
      requestId: "generation-response-123",
      finishState: "length",
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
      serviceTimeMs: 42,
      errorClass: "incomplete"
    });

    expect(diagnostic).toMatchObject({
      providerKind: "generation",
      apiMode: "chat_completions",
      modelName: "generation-model",
      providerRequestId: "generation-response-123",
      providerErrorType: "incomplete",
      providerErrorCode: "length",
      errorMessage: "Provider response was classified as incomplete: length"
    });
  });

  it("does not let a failing log sink change the provider error", async () => {
    const failure = new Error("provider unavailable");
    const reporter = vi.fn(() => {
      throw new Error("log sink unavailable");
    });
    const client = withProviderFailureReporting({
      apiMode: "responses",
      responses: { create: vi.fn().mockRejectedValue(failure) }
    }, {
      apiMode: "responses",
      baseUrl: "https://generation.example/v1",
      modelName: "generation-model"
    }, reporter);

    if (client.apiMode === "chat_completions") {
      throw new Error("Unexpected client mode");
    }
    await expect(client.responses.create({} as never)).rejects.toBe(failure);
    expect(reporter).toHaveBeenCalledOnce();
    reportProviderFailureOnce(reporter, {
      providerKind: "generation",
      apiMode: "responses",
      providerHost: null,
      providerRoute: null,
      modelName: "generation-model",
      httpStatusCode: null,
      providerRequestId: null,
      providerRetryAfter: null,
      providerErrorType: null,
      providerErrorCode: null,
      providerErrorParam: null,
      providerFinishState: null,
      errorClass: "Error",
      errorMessage: "provider unavailable"
    }, failure);
    expect(reporter).toHaveBeenCalledOnce();
  });
});
