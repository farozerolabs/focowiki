import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminFetch,
  createUploadSession,
  fetchKnowledgeBaseFileDetail,
  fetchKnowledgeBaseFileTree,
  fetchKnowledgeBaseProcessingSummary,
  fetchKnowledgeBasePublicUrls,
  fetchSourceFile,
  listKnowledgeBases,
  listPublicOpenApiKeys,
  listSourceFiles,
  loginAdmin,
  searchKnowledgeBaseFileTree,
  setAdminAuthFailureHandler,
  updateWorkerSettings
} from "../src/lib/admin-api";

describe("Admin HTTP authentication handling", () => {
  afterEach(() => {
    setAdminAuthFailureHandler(null);
    vi.unstubAllGlobals();
  });

  it("clears the session for 401 responses", async () => {
    const handler = vi.fn();
    setAdminAuthFailureHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));

    await adminFetch("/admin/api/session");

    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps the current session for safe 403 responses", async () => {
    const handler = vi.fn();
    setAdminAuthFailureHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));

    await adminFetch("/admin/api/settings");

    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves the retry interval for rate-limited login responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { code: "RATE_LIMITED" } }),
      { status: 429, headers: { "retry-after": "900" } }
    )));

    await expect(loginAdmin({ username: "admin", password: "wrong" })).resolves.toEqual({
      authenticated: false,
      error: "rate_limited",
      retryAfterSeconds: 900
    });
  });

  it("maps an unreachable Admin API to the login request failure contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    await expect(loginAdmin({ username: "admin", password: "secret" })).resolves.toEqual({
      authenticated: false,
      error: "request_failed",
      retryAfterSeconds: null
    });
  });

  it("preserves runtime setting issue fields for actionable UI feedback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        messageKey: "errors.runtimeSettingsValidationFailed",
        issues: [{
          field: "objectStoreCapacity",
          message: "Aggregate object-store concurrency exceeds deployment capacity"
        }]
      }
    }), {
      status: 422,
      headers: { "content-type": "application/json" }
    })));

    await expect(updateWorkerSettings({} as never)).resolves.toEqual({
      messageKey: "errors.runtimeSettingsValidationFailed",
      issues: [{ field: "objectStoreCapacity" }]
    });
  });

  it("does not turn failed list requests into truthful-looking empty pages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { messageKey: "errors.serviceUnavailable" }
    }), { status: 503 })));

    await expect(listKnowledgeBases({})).rejects.toThrow("errors.serviceUnavailable");
    await expect(listPublicOpenApiKeys({})).rejects.toThrow("errors.serviceUnavailable");
  });

  it("does not turn failed detail reads into empty or idle product state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { messageKey: "errors.serviceUnavailable" }
    }), { status: 503, headers: { "content-type": "application/json" } })));

    await expect(fetchKnowledgeBaseFileTree({ knowledgeBaseId: "kb-docs" }))
      .rejects.toThrow("errors.serviceUnavailable");
    await expect(searchKnowledgeBaseFileTree({ knowledgeBaseId: "kb-docs", query: "guide" }))
      .rejects.toThrow("errors.serviceUnavailable");
    await expect(fetchKnowledgeBaseFileDetail({ knowledgeBaseId: "kb-docs", path: "pages/a.md" }))
      .rejects.toThrow("errors.serviceUnavailable");
    await expect(fetchKnowledgeBaseProcessingSummary({ knowledgeBaseId: "kb-docs" }))
      .rejects.toThrow("errors.serviceUnavailable");
    await expect(fetchKnowledgeBasePublicUrls({ knowledgeBaseId: "kb-docs" }))
      .rejects.toThrow("errors.serviceUnavailable");
    await expect(listSourceFiles({ knowledgeBaseId: "kb-docs" }))
      .rejects.toThrow("errors.serviceUnavailable");
  });

  it("treats only a missing source file as absent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { messageKey: "errors.serviceUnavailable" }
      }), { status: 503, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSourceFile({
      knowledgeBaseId: "kb-docs",
      sourceFileId: "source-missing"
    })).resolves.toBeNull();
    await expect(fetchSourceFile({
      knowledgeBaseId: "kb-docs",
      sourceFileId: "source-unavailable"
    })).rejects.toThrow("errors.serviceUnavailable");
  });

  it.each([
    ["UPLOAD_MANIFEST_DUPLICATE_PATH", "errors.uploadPathReserved"],
    ["UPLOAD_SESSION_EXPIRED", "errors.uploadSessionUnavailable"],
    ["UPLOAD_MANIFEST_TOTAL_MISMATCH", "errors.uploadSelectionChanged"],
    ["UPLOAD_ENTRY_CHECKSUM_MISMATCH", "errors.uploadContentChanged"]
  ])("maps upload error %s to an actionable message", async (code, messageKey) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code }
    }), { status: 409 })));

    await expect(createUploadSession({
      knowledgeBaseId: "kb-docs",
      idempotencyKey: "upload-attempt",
      declaredFileCount: 1,
      declaredByteCount: 12
    })).resolves.toEqual({ messageKey });
  });
});
