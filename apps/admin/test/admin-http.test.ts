import { afterEach, describe, expect, it, vi } from "vitest";
import { adminFetch, setAdminAuthFailureHandler } from "../src/lib/admin-api";

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
});
