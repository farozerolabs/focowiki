import type { CSSProperties } from "react";
import type { KnowledgeBase } from "@/lib/admin-api";

export const ROOT_PARENT_PATH = "";
export const SOURCE_FILE_REFRESH_INTERVAL_MS = 2_000;
export const SOURCE_FILE_FILTER_DEBOUNCE_MS = 300;
export const DETAIL_SIDEBAR_MIN_WIDTH_PX = 256;
export const DETAIL_SIDEBAR_MAX_WIDTH_PX = 512;
export const DETAIL_SIDEBAR_DEFAULT_WIDTH_PX = DETAIL_SIDEBAR_MIN_WIDTH_PX;

export type ActiveKnowledgeBaseView = "file" | "processing" | "settings";

export type KnowledgeBaseDetailPageProps = {
  knowledgeBase: KnowledgeBase;
  onBack: () => void;
  onLogout: () => void;
};

export function detailSidebarStyle(width: number): CSSProperties {
  return { "--sidebar-width": `${width}px` } as CSSProperties;
}

export function readAdminErrorMessageKey(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "errors.serviceUnavailable";
}
