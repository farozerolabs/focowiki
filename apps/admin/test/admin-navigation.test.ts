import { beforeEach, describe, expect, it } from "vitest";
import { navigateAdminView, readAdminView } from "../src/lib/admin-navigation";

describe("admin navigation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("round-trips a knowledge base detail view through the URL", () => {
    navigateAdminView({ type: "knowledge-base", knowledgeBaseId: "kb-docs" });

    expect(window.location.search).toBe("?view=knowledge-base&knowledgeBaseId=kb-docs");
    expect(readAdminView()).toEqual({
      type: "knowledge-base",
      knowledgeBaseId: "kb-docs"
    });
  });

  it("round-trips settings and clears navigation parameters for home", () => {
    navigateAdminView({ type: "settings" });
    expect(readAdminView()).toEqual({ type: "settings" });

    navigateAdminView({ type: "home" });
    expect(window.location.search).toBe("");
    expect(readAdminView()).toEqual({ type: "home" });
  });

  it("round-trips the OpenAPI key view through the URL", () => {
    navigateAdminView({ type: "openapi-keys" });

    expect(window.location.search).toBe("?view=openapi-keys");
    expect(readAdminView()).toEqual({ type: "openapi-keys" });
  });

  it("round-trips the model settings view through the URL", () => {
    navigateAdminView({ type: "model-settings" });

    expect(window.location.search).toBe("?view=model-settings");
    expect(readAdminView()).toEqual({ type: "model-settings" });
  });

  it("treats incomplete knowledge base routes as home", () => {
    window.history.replaceState(null, "", "/?view=knowledge-base");

    expect(readAdminView()).toEqual({ type: "home" });
  });
});
