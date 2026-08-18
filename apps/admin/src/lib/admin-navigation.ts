export type AdminView =
  | { type: "home" }
  | { type: "openapi-keys" }
  | { type: "model-settings" }
  | { type: "settings" }
  | { type: "knowledge-base"; knowledgeBaseId: string };

export function readAdminView(): AdminView {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");

  if (view === "settings") {
    return { type: "settings" };
  }
  if (view === "model-settings") {
    return { type: "model-settings" };
  }
  if (view === "openapi-keys") {
    return { type: "openapi-keys" };
  }
  if (view === "knowledge-base") {
    const knowledgeBaseId = params.get("knowledgeBaseId")?.trim();
    if (knowledgeBaseId) {
      return { type: "knowledge-base", knowledgeBaseId };
    }
  }
  return { type: "home" };
}

export function navigateAdminView(
  view: AdminView,
  mode: "push" | "replace" = "push"
): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("view");
  url.searchParams.delete("knowledgeBaseId");

  if (view.type === "settings") {
    url.searchParams.set("view", "settings");
  } else if (view.type === "model-settings") {
    url.searchParams.set("view", "model-settings");
  } else if (view.type === "openapi-keys") {
    url.searchParams.set("view", "openapi-keys");
  } else if (view.type === "knowledge-base") {
    url.searchParams.set("view", "knowledge-base");
    url.searchParams.set("knowledgeBaseId", view.knowledgeBaseId);
  }

  window.history[mode === "replace" ? "replaceState" : "pushState"](
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}
