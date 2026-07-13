import { useTranslation } from "react-i18next";

export function useDetailSidebarLabels() {
  const { t } = useTranslation();
  return {
    back: t("detail.back"),
    files: t("result.fileTree"),
    uploadProgress: t("tasks.title"),
    loadMore: t("home.loadMore"),
    logout: t("auth.logout"),
    running: t("tasks.runningShort"),
    ended: t("tasks.endedShort"),
    deleteFile: t("delete.action"),
    deleteDirectory: t("delete.directoryAction"),
    fileActions: t("delete.fileMenu"),
    directoryActions: t("delete.directoryMenu"),
    rename: t("resourceEditing.rename"),
    move: t("resourceEditing.move"),
    replaceContent: t("resourceEditing.replaceContent"),
    emptyFiles: t("detail.emptyFiles"),
    loadingFiles: t("detail.loadingFiles"),
    fileTreeSearchPlaceholder: t("detail.fileTreeSearchPlaceholder"),
    clearFileTreeSearch: t("detail.clearFileTreeSearch"),
    fileTreeSearchNoResults: t("detail.fileTreeSearchNoResults"),
    fileTreeSearchLoadMore: t("detail.fileTreeSearchLoadMore")
  };
}
