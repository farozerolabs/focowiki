import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminPageHeader } from "@/components/admin-page-header";
import { AppSidebar, type AdminSidebarTreeNode } from "@/components/app-sidebar";
import { FilePreviewPanel } from "@/components/file-preview-panel";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { SourceFileProgressPanel } from "@/components/task-progress-panel";
import { KnowledgeBaseMaintenancePanel } from "@/components/knowledge-base-maintenance-panel";
import { UploadSourceDialog } from "@/components/upload-source-dialog";
import { SourceDirectoryDeleteDialog } from "@/components/source-directory-delete-dialog";
import { SourceFileDeleteDialog } from "@/components/source-file-delete-dialog";
import { SourceResourceEditor } from "@/components/source-resource-editor";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import {
  completeCursorPageRequest,
  createInitialCursorPageState,
  moveToNextCursor,
  moveToPreviousCursor,
  type CursorPageState
} from "@/lib/cursor-page-state";
import {
  hasProcessingBackgroundActivity,
  normalizeSourceFileRefreshAfterMs,
  rememberSourceFileRefreshSnapshots,
  shouldRefreshGeneratedFiles, type SourceFileRefreshSnapshot
} from "@/lib/source-file-refresh";
import {
  fetchKnowledgeBaseFileTree,
  fetchKnowledgeBaseProcessingSummary,
  fetchKnowledgeBaseIndexMaintenance,
  listSourceFiles, retryKnowledgeBaseSourceFile,
  type IndexMaintenanceStatus, type ProcessingSummary, type SourceFilePage, type SourceFileRecord
} from "@/lib/admin-api";
import { deleteCurrentSourceFile } from "@/lib/resource-editing-api";
import { useSourceDirectoryDeletion } from "@/hooks/use-source-directory-deletion";
import { useFileTreeSearch } from "@/hooks/use-file-tree-search";
import {
  buildSidebarSearchTree,
  buildSidebarTree,
  sourceFileEditorNode,
  type TreePageState
} from "@/lib/sidebar-tree";
import {
  createEmptySourceFileListFilters,
  hasActiveSourceFileFilters,
  type SourceFileListFilters
} from "@/lib/source-file-list-filters";
import { useSourceFileTaskDeletionHandler } from "@/hooks/use-source-file-task-deletion-handler";
import { showAdminToast } from "@/hooks/use-admin-toast";
import { useDetailResourceEditing } from "@/hooks/use-detail-resource-editing";
import { useDetailPageRefresh } from "@/hooks/use-detail-page-refresh";
import { useDetailSidebarLabels } from "@/hooks/use-detail-sidebar-labels";
import { useGeneratedFilePreview } from "@/hooks/use-generated-file-preview";
import {
  DETAIL_SIDEBAR_DEFAULT_WIDTH_PX, DETAIL_SIDEBAR_MAX_WIDTH_PX,
  DETAIL_SIDEBAR_MIN_WIDTH_PX, ROOT_PARENT_PATH, SOURCE_FILE_FILTER_DEBOUNCE_MS,
  SOURCE_FILE_REFRESH_INTERVAL_MS, detailSidebarStyle, readAdminErrorMessageKey,
  type ActiveKnowledgeBaseView, type KnowledgeBaseDetailPageProps
} from "@/lib/knowledge-base-detail-view";

export function KnowledgeBaseDetailPage({
  knowledgeBase,
  onBack,
  onLogout
}: KnowledgeBaseDetailPageProps) {
  const { t } = useTranslation();
  const sidebarLabels = useDetailSidebarLabels();
  const sourceFileRefreshSnapshotsRef = useRef<Map<string, SourceFileRefreshSnapshot>>(new Map());
  const sourceFilePageStateRef = useRef<CursorPageState>(createInitialCursorPageState());
  const sourceFileFiltersRef = useRef<SourceFileListFilters>(createEmptySourceFileListFilters());
  const sourceFileRequestIdRef = useRef(0);
  const sourceFileFilterTimeoutRef = useRef<number | null>(null);
  const loadedTreeParentsRef = useRef<Set<string>>(new Set());
  const activeViewRef = useRef<ActiveKnowledgeBaseView>("processing");
  const sourceFilesRef = useRef<SourceFileRecord[]>([]);
  const isSourceFilePageLoadingRef = useRef(false);
  const sourceFileRefreshIntervalMsRef = useRef(SOURCE_FILE_REFRESH_INTERVAL_MS);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [activeView, setActiveView] = useState<ActiveKnowledgeBaseView>("processing");
  const [treePages, setTreePages] = useState<Record<string, TreePageState>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [fileTreeError, setFileTreeError] = useState("");
  const [processingSummaryError, setProcessingSummaryError] = useState("");
  const [indexMaintenanceError, setIndexMaintenanceError] = useState("");
  const [deleteFileTarget, setDeleteFileTarget] = useState<AdminSidebarTreeNode | null>(null);
  const [deleteFileError, setDeleteFileError] = useState("");
  const [isDeletingFile, setIsDeletingFile] = useState(false);
  const [sourceFiles, setSourceFiles] = useState<SourceFileRecord[]>([]);
  const [sourceFileFilters, setSourceFileFilters] = useState<SourceFileListFilters>(createEmptySourceFileListFilters);
  const [sourceFilePageState, setSourceFilePageState] = useState<CursorPageState>(createInitialCursorPageState);
  const [isSourceFilePageLoading, setIsSourceFilePageLoading] = useState(false);
  const [sourceFileError, setSourceFileError] = useState("");
  const [retryingSourceFileId, setRetryingSourceFileId] = useState<string | null>(null);
  const [processingSummary, setProcessingSummary] = useState<ProcessingSummary | null>(null);
  const [indexMaintenance, setIndexMaintenance] = useState<IndexMaintenanceStatus | null>(null);
  const [detailSidebarWidth, setDetailSidebarWidth] = useState(DETAIL_SIDEBAR_DEFAULT_WIDTH_PX);
  const preview = useGeneratedFilePreview(knowledgeBase.id);
  const {
    clearSelectedFile,
    copiedUrl,
    copyUrl,
    loadPublicUrls,
    openPreviewPath: loadPreviewPath,
    previewError,
    previewHtml,
    publicUrls,
    publicUrlsError,
    relationships: selectedFileRelationships,
    selectedFilePath,
    selectedFileTitle,
    selectedSourceFileId
  } = preview;
  const fileTreeSearch = useFileTreeSearch(knowledgeBase.id);
  const handleDeleteSourceFileTasks = useSourceFileTaskDeletionHandler({
    knowledgeBaseId: knowledgeBase.id,
    sourceFilePageStateRef,
    setRetryingSourceFileId,
    loadSourceFiles,
    loadProcessingSummary
  });
  const resourceEditing = useDetailResourceEditing({
    knowledgeBaseId: knowledgeBase.id,
    selectedSourceFileId,
    refresh: async () => {
      await Promise.all([refreshGeneratedFiles(), loadFirstSourceFilePage()]);
    },
    reopen: openPreviewPath
  });
  const directoryDeletion = useSourceDirectoryDeletion({
    knowledgeBaseId: knowledgeBase.id,
    selectedFilePath,
    setTreePages,
    setExpandedDirectories,
    clearSelectedFile,
    refreshProcessingSummary: loadProcessingSummary,
    trackOperation: resourceEditing.track
  });

  const rootTreePage = treePages[ROOT_PARENT_PATH];
  const sidebarTree = useMemo(
    () =>
      fileTreeSearch.isSearchActive
        ? buildSidebarSearchTree(fileTreeSearch.results, selectedFilePath)
        : buildSidebarTree(treePages, expandedDirectories, selectedFilePath, ROOT_PARENT_PATH),
    [
      expandedDirectories,
      fileTreeSearch.isSearchActive,
      fileTreeSearch.results,
      selectedFilePath,
      treePages
    ]
  );
  const sidebarProviderStyle = detailSidebarStyle(detailSidebarWidth);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    sourceFilesRef.current = sourceFiles;
  }, [sourceFiles]);

  const sourceProcessingActive = hasProcessingBackgroundActivity(processingSummary);

  useEffect(() => {
    setIsUploadDialogOpen(false);
    setActiveView("processing");
    setTreePages({});
    setExpandedDirectories(new Set());
    clearSelectedFile();
    setDeleteFileTarget(null);
    resourceEditing.setRequest(null);
    directoryDeletion.setTarget(null);
    setDeleteFileError("");
    setFileTreeError("");
    setProcessingSummaryError("");
    setIndexMaintenanceError("");
    setIsDeletingFile(false);
    setSourceFiles([]);
    const emptySourceFileFilters = createEmptySourceFileListFilters();
    sourceFileFiltersRef.current = emptySourceFileFilters;
    setSourceFileFilters(emptySourceFileFilters);
    const initialSourceFilePageState = createInitialCursorPageState();
    sourceFilePageStateRef.current = initialSourceFilePageState;
    setSourceFilePageState(initialSourceFilePageState);
    isSourceFilePageLoadingRef.current = false;
    setIsSourceFilePageLoading(false);
    setSourceFileError("");
    setRetryingSourceFileId(null);
    setProcessingSummary(null);
    setDetailSidebarWidth(DETAIL_SIDEBAR_DEFAULT_WIDTH_PX);
    sourceFileRefreshSnapshotsRef.current = new Map();
    sourceFileRequestIdRef.current += 1;
    if (sourceFileFilterTimeoutRef.current !== null) {
      window.clearTimeout(sourceFileFilterTimeoutRef.current);
      sourceFileFilterTimeoutRef.current = null;
    }
    loadedTreeParentsRef.current = new Set();

    void loadFileTree({ parentPath: ROOT_PARENT_PATH, replace: true });
    void loadFirstSourceFilePage();
  }, [knowledgeBase.id]);

  useDetailPageRefresh({
    knowledgeBaseId: knowledgeBase.id,
    activeViewRef,
    sourceFilesRef,
    hasBackgroundActivity: sourceProcessingActive,
    sourceFilePageLoadingRef: isSourceFilePageLoadingRef,
    sourceFileFilterTimeoutRef,
    refreshIntervalMsRef: sourceFileRefreshIntervalMsRef,
    refreshSourceFiles: () =>
      void loadSourceFiles({ pageState: sourceFilePageStateRef.current }),
    refreshMaintenance: () => void loadIndexMaintenance()
  });

  async function loadFileTree(input: { parentPath: string; replace: boolean }) {
    const currentCursor = input.replace ? null : treePages[input.parentPath]?.nextCursor ?? null;

    setTreePages((current) => ({
      ...current,
      [input.parentPath]: {
        items: input.replace ? [] : current[input.parentPath]?.items ?? [],
        nextCursor: input.replace ? null : current[input.parentPath]?.nextCursor ?? null,
        isLoading: true
      }
    }));

    let page;
    try {
      page = await fetchKnowledgeBaseFileTree({
        knowledgeBaseId: knowledgeBase.id,
        ...(input.parentPath ? { parentPath: input.parentPath } : {}),
        cursor: currentCursor
      });
      setFileTreeError("");
    } catch (error) {
      setFileTreeError(readAdminErrorMessageKey(error));
      setTreePages((current) => ({
        ...current,
        [input.parentPath]: {
          items: current[input.parentPath]?.items ?? [],
          nextCursor: current[input.parentPath]?.nextCursor ?? null,
          isLoading: false
        }
      }));
      return;
    }

    setTreePages((current) => {
      const previousItems = input.replace ? [] : current[input.parentPath]?.items ?? [];

      return {
        ...current,
        [input.parentPath]: {
          items: [...previousItems, ...page.items],
          nextCursor: page.nextCursor,
          isLoading: false
        }
      };
    });
    loadedTreeParentsRef.current.add(input.parentPath);
  }

  async function handleToggleDirectory(node: AdminSidebarTreeNode, open: boolean) {
    setExpandedDirectories((current) => {
      const next = new Set(current);

      if (open) {
        next.add(node.logicalPath);
      } else {
        next.delete(node.logicalPath);
      }

      return next;
    });

    if (open) {
      await loadFileTree({ parentPath: node.logicalPath, replace: true });
    }
  }

  async function handleSelectFile(node: AdminSidebarTreeNode) {
    await openPreviewPath(node.logicalPath, node.name);
  }

  async function openPreviewPath(logicalPath: string, title: string) {
    setActiveView("file");
    await loadPreviewPath(logicalPath, title);
  }

  async function loadSourceFiles(input: {
    pageState: CursorPageState;
    filters?: SourceFileListFilters;
  }) {
    const requestId = sourceFileRequestIdRef.current + 1;
    sourceFileRequestIdRef.current = requestId;
    isSourceFilePageLoadingRef.current = true;
    setIsSourceFilePageLoading(true);
    const filters = input.filters ?? sourceFileFiltersRef.current;
    try {
      let page: SourceFilePage;

      try {
        page = await listSourceFiles({
          knowledgeBaseId: knowledgeBase.id,
          cursor: input.pageState.currentCursor,
          ...(hasActiveSourceFileFilters(filters) ? { filters } : {})
        });
      } catch (error) {
        if (requestId !== sourceFileRequestIdRef.current) {
          return;
        }
        const messageKey = readAdminErrorMessageKey(error);
        if (messageKey === "pagination.expired" && input.pageState.currentCursor) {
          const nextPageState = createInitialCursorPageState();
          sourceFilePageStateRef.current = nextPageState;
          setSourceFilePageState(nextPageState);
          setSourceFileError(messageKey);
          try {
            page = await listSourceFiles({
              knowledgeBaseId: knowledgeBase.id,
              cursor: nextPageState.currentCursor,
              ...(hasActiveSourceFileFilters(filters) ? { filters } : {})
            });
            if (requestId === sourceFileRequestIdRef.current) {
              await applySourceFilePage(nextPageState, page);
            }
          } catch (retryError) {
            setSourceFileError(readAdminErrorMessageKey(retryError));
          }
        } else {
          setSourceFileError(messageKey);
        }
        return;
      }

      if (requestId !== sourceFileRequestIdRef.current) {
        return;
      }
      await applySourceFilePage(input.pageState, page);
      await loadProcessingSummary();
      setSourceFileError("");
    } finally {
      if (requestId === sourceFileRequestIdRef.current) {
        isSourceFilePageLoadingRef.current = false;
        setIsSourceFilePageLoading(false);
      }
    }
  }

  async function applySourceFilePage(pageState: CursorPageState, page: SourceFilePage) {
    const hasSourceFileSnapshot = sourceFileRefreshSnapshotsRef.current.size > 0;
    const shouldRefreshGeneratedTree =
      hasSourceFileSnapshot &&
      shouldRefreshGeneratedFiles(sourceFileRefreshSnapshotsRef.current, page.items);
    const nextPageState = completeCursorPageRequest(pageState, page.nextCursor);

    setSourceFiles(page.items);
    sourceFileRefreshIntervalMsRef.current = normalizeSourceFileRefreshAfterMs(page.refreshAfterMs, SOURCE_FILE_REFRESH_INTERVAL_MS);
    sourceFilePageStateRef.current = nextPageState;
    setSourceFilePageState(nextPageState);
    sourceFileRefreshSnapshotsRef.current = rememberSourceFileRefreshSnapshots(page.items);

    if (shouldRefreshGeneratedTree && activeViewRef.current === "file") {
      await refreshGeneratedFiles();
    }
  }

  async function loadFirstSourceFilePage(filters: SourceFileListFilters = sourceFileFiltersRef.current) {
    const nextPageState = createInitialCursorPageState();

    sourceFilePageStateRef.current = nextPageState;
    setSourceFilePageState(nextPageState);
    await loadSourceFiles({ pageState: nextPageState, filters });
  }

  async function handleNextSourceFilePage() {
    const nextPageState = moveToNextCursor(sourceFilePageStateRef.current);

    if (nextPageState === sourceFilePageStateRef.current) {
      return;
    }

    sourceFilePageStateRef.current = nextPageState;
    setSourceFilePageState(nextPageState);
    await loadSourceFiles({ pageState: nextPageState });
  }

  async function handlePreviousSourceFilePage() {
    const nextPageState = moveToPreviousCursor(sourceFilePageStateRef.current);

    if (nextPageState === sourceFilePageStateRef.current) {
      return;
    }

    sourceFilePageStateRef.current = nextPageState;
    setSourceFilePageState(nextPageState);
    await loadSourceFiles({ pageState: nextPageState });
  }

  function handleSourceFileFiltersChange(filters: SourceFileListFilters) {
    sourceFileFiltersRef.current = filters;
    setSourceFileFilters(filters);
    setSourceFileError("");
    const nextPageState = createInitialCursorPageState();

    sourceFilePageStateRef.current = nextPageState;
    setSourceFilePageState(nextPageState);
    if (sourceFileFilterTimeoutRef.current !== null) {
      window.clearTimeout(sourceFileFilterTimeoutRef.current);
    }
    sourceFileFilterTimeoutRef.current = window.setTimeout(() => {
      sourceFileFilterTimeoutRef.current = null;
      void loadSourceFiles({ pageState: nextPageState, filters });
    }, SOURCE_FILE_FILTER_DEBOUNCE_MS);
  }

  function handleClearSourceFileFilters() {
    const filters = createEmptySourceFileListFilters();

    handleSourceFileFiltersChange(filters);
  }

  async function refreshGeneratedFiles() {
    const parentPaths = new Set([ROOT_PARENT_PATH, ...loadedTreeParentsRef.current]);

    await Promise.all([
      ...Array.from(parentPaths).map((parentPath) =>
        loadFileTree({ parentPath, replace: true })
      ),
      loadPublicUrls(),
      fileTreeSearch.refresh()
    ]);
  }

  async function handleRetrySourceFile(sourceFile: SourceFileRecord) {
    setRetryingSourceFileId(sourceFile.id);
    setSourceFileError("");

    try {
      const result = await retryKnowledgeBaseSourceFile({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: sourceFile.id
      });

      if ("messageKey" in result) {
        setSourceFileError(result.messageKey);
        return;
      }

      await loadFirstSourceFilePage();
      await refreshGeneratedFiles();
    } finally {
      setRetryingSourceFileId(null);
    }
  }

  async function loadProcessingSummary() {
    try {
      const summary = await fetchKnowledgeBaseProcessingSummary({
        knowledgeBaseId: knowledgeBase.id
      });
      setProcessingSummary(summary);
      setProcessingSummaryError("");
    } catch (error) {
      setProcessingSummaryError(readAdminErrorMessageKey(error));
    }
  }

  async function loadIndexMaintenance() {
    try {
      const maintenance = await fetchKnowledgeBaseIndexMaintenance({
        knowledgeBaseId: knowledgeBase.id
      });
      setIndexMaintenance(maintenance);
      setIndexMaintenanceError("");
    } catch (error) {
      setIndexMaintenanceError(readAdminErrorMessageKey(error));
    }
  }

  async function handleDeleteFile() {
    const target = deleteFileTarget;

    if (!target) {
      return;
    }

    if (!target.sourceFileId) {
      setDeleteFileError("errors.invalidResourceRevision");
      return;
    }

    setDeleteFileError("");
    setSourceFileError("");
    setActiveView("processing");
    setDeleteFileTarget(null);
    setIsDeletingFile(true);
    const result = await deleteCurrentSourceFile({
      knowledgeBaseId: knowledgeBase.id,
      sourceFileId: target.sourceFileId
    });
    setIsDeletingFile(false);

    if ("messageKey" in result) {
      setSourceFileError(result.messageKey);
      return;
    }

    if (selectedFilePath === target.logicalPath) {
      clearSelectedFile();
    }

    resourceEditing.track(result.operation);
    await loadFirstSourceFilePage();
    await refreshGeneratedFiles();
  }

  return (
    <SidebarProvider
      className="h-svh min-h-0 overflow-hidden"
      style={sidebarProviderStyle}
    >
      <AppSidebar
        appName={t("app.name")}
        knowledgeBaseName={knowledgeBase.name}
        labels={sidebarLabels}
        activeView={activeView}
        tree={sidebarTree}
        rootNextCursor={rootTreePage?.nextCursor ?? null}
        rootLoading={Boolean(rootTreePage?.isLoading)}
        sourceFiles={sourceFiles}
        sourceProcessingActive={sourceProcessingActive}
        onBack={onBack}
        onLogout={onLogout}
        onOpenProcessing={() => setActiveView("processing")}
        onOpenSettings={() => {
          setActiveView("settings");
          void loadIndexMaintenance();
        }}
        onOpenFile={(node) => void handleSelectFile(node)}
        onDeleteFile={(node) => {
          setDeleteFileError("");
          setDeleteFileTarget(node);
        }}
        onDeleteDirectory={directoryDeletion.setTarget}
        onEditResource={(action, node) => resourceEditing.setRequest({ action, node })}
        isResourceBusy={(node) =>
          resourceEditing.isTargetBusy(node.sourceFileId ?? node.sourceDirectoryId)
        }
        onToggleDirectory={(node, open) => void handleToggleDirectory(node, open)}
        onLoadMoreTree={(parentPath) => void loadFileTree({ parentPath, replace: false })}
        fileTreeSearch={{
          query: fileTreeSearch.query,
          isActive: fileTreeSearch.isSearchActive,
          isLoading: fileTreeSearch.isLoading,
          nextCursor: fileTreeSearch.nextCursor,
          statusMessage: fileTreeSearch.errorMessageKey
            ? t(fileTreeSearch.errorMessageKey)
            : fileTreeError
              ? t(fileTreeError)
              : null,
          onQueryChange: fileTreeSearch.setQuery,
          onClear: fileTreeSearch.clear,
          onLoadMore: () => void fileTreeSearch.loadMore()
        }}
        resizeRail={{
          label: t("detail.resizeSidebar"),
          maxWidth: DETAIL_SIDEBAR_MAX_WIDTH_PX,
          minWidth: DETAIL_SIDEBAR_MIN_WIDTH_PX,
          width: detailSidebarWidth,
          onWidthChange: setDetailSidebarWidth
        }}
      />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <AdminPageHeader
          start={
            <>
              <SidebarTrigger aria-label={t("detail.toggleSidebar")} />
              <Separator orientation="vertical" className="h-4" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {activeView === "processing"
                    ? t("tasks.title")
                    : activeView === "settings"
                      ? t("detail.settings")
                      : selectedFileTitle || selectedFilePath || t("result.preview")}
                </p>
                <p className="truncate text-xs text-muted-foreground">{knowledgeBase.name}</p>
              </div>
            </>
          }
          end={<LanguageSwitch />}
        />
        <section
          data-slot="knowledge-base-detail-content"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4"
        >
          {activeView === "processing" ? (
            <SourceFileProgressPanel
              sourceFiles={sourceFiles}
              filters={sourceFileFilters}
              hasActiveFilters={hasActiveSourceFileFilters(sourceFileFilters)}
              summary={processingSummary}
              pagination={{
                hasNext: Boolean(sourceFilePageState.nextCursor),
                hasPrevious: sourceFilePageState.previousCursors.length > 0,
                isLoading: isSourceFilePageLoading,
                pageNumber: sourceFilePageState.pageNumber
              }}
              onNextPage={() => void handleNextSourceFilePage()}
              onPreviousPage={() => void handlePreviousSourceFilePage()}
              onRefresh={() => void loadSourceFiles({ pageState: sourceFilePageStateRef.current })}
              onUpload={() => setIsUploadDialogOpen(true)}
              onFiltersChange={handleSourceFileFiltersChange}
              onClearFilters={handleClearSourceFileFilters}
              errorMessageKey={sourceFileError || processingSummaryError}
              retryingSourceFileId={retryingSourceFileId}
              onRetrySourceFile={(sourceFile) => void handleRetrySourceFile(sourceFile)}
              onReplaceSourceFile={(sourceFile) => resourceEditing.setRequest({
                action: "replace",
                node: sourceFileEditorNode(sourceFile)
              })}
              onDeleteSourceFileTasks={handleDeleteSourceFileTasks}
              onOpenGeneratedFile={(sourceFile) => {
                const generatedFilePath = sourceFile.generatedFilePath;
                if (generatedFilePath) {
                  void (async () => {
                    await refreshGeneratedFiles();
                    await openPreviewPath(generatedFilePath, generatedFilePath.split("/").at(-1) ?? sourceFile.name);
                  })();
                }
              }}
            />
          ) : activeView === "settings" ? (
            <KnowledgeBaseMaintenancePanel
              knowledgeBaseId={knowledgeBase.id}
              maintenance={indexMaintenance}
              errorMessageKey={indexMaintenanceError}
              onRefresh={loadIndexMaintenance}
            />
          ) : (
            <FilePreviewPanel
              copiedUrl={copiedUrl}
              previewHtml={previewHtml}
              publicUrls={publicUrls}
              relationships={selectedFileRelationships}
              selectedFileTitle={selectedFileTitle}
              selectedFilePath={selectedFilePath}
              errorMessageKey={previewError || publicUrlsError}
              onCopy={(url) => void copyUrl(url)}
              onOpenPreviewPath={(path, title) => void openPreviewPath(path, title)}
            />
          )}
        </section>
      </SidebarInset>

      <UploadSourceDialog
        knowledgeBaseId={knowledgeBase.id}
        open={isUploadDialogOpen}
        onOpenChange={setIsUploadDialogOpen}
        onAccepted={async () => {
          setActiveView("processing");
          await loadFirstSourceFilePage();
        }}
      />
      <SourceFileDeleteDialog
        target={deleteFileTarget}
        busy={isDeletingFile}
        errorMessageKey={deleteFileError}
        onClose={() => setDeleteFileTarget(null)}
        onConfirm={() => void handleDeleteFile()}
      />
      <SourceDirectoryDeleteDialog
        target={directoryDeletion.target}
        busy={directoryDeletion.isDeleting}
        onClose={() => directoryDeletion.setTarget(null)}
        onConfirm={() => void directoryDeletion.deleteTarget()}
      />
      <SourceResourceEditor
        knowledgeBaseId={knowledgeBase.id}
        request={resourceEditing.request}
        onClose={() => resourceEditing.setRequest(null)}
        onAccepted={(operation) => {
          resourceEditing.accept(operation);
          showAdminToast({
            title: t("resourceEditing.acceptedTitle"),
            description: t("resourceEditing.acceptedDescription")
          });
        }}
      />
    </SidebarProvider>
  );
}
