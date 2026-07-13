import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppSidebar, type AdminSidebarTreeNode } from "@/components/app-sidebar";
import { FilePreviewPanel } from "@/components/file-preview-panel";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { SourceFileProgressPanel } from "@/components/task-progress-panel";
import { UploadSourceDialog } from "@/components/upload-source-dialog";
import { SourceDirectoryDeleteDialog } from "@/components/source-directory-delete-dialog";
import { SourceFileDeleteDialog } from "@/components/source-file-delete-dialog";
import {
  SourceResourceEditor
} from "@/components/source-resource-editor";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { escapeHtml, renderMarkdownPreview } from "@/lib/markdown-preview";
import {
  completeCursorPageRequest,
  createInitialCursorPageState,
  moveToNextCursor,
  moveToPreviousCursor,
  type CursorPageState
} from "@/lib/cursor-page-state";
import {
  normalizeSourceFileRefreshAfterMs,
  rememberSourceFileRefreshSnapshots,
  shouldScheduleSourceFileRefresh,
  shouldRefreshGeneratedFiles,
  type SourceFileRefreshSnapshot
} from "@/lib/source-file-refresh";
import {
  deleteKnowledgeBaseFile,
  fetchKnowledgeBaseFileDetail,
  fetchKnowledgeBaseFileTree,
  fetchKnowledgeBaseProcessingSummary,
  fetchKnowledgeBasePublicUrls,
  listSourceFiles,
  retryKnowledgeBaseSourceFile,
  type KnowledgeBase,
  type KnowledgeBasePublicUrls,
  type ProcessingSummary,
  type SourceFilePage,
  type SourceFileRecord
} from "@/lib/admin-api";
import { useSourceDirectoryDeletion } from "@/hooks/use-source-directory-deletion";
import { useFileTreeSearch } from "@/hooks/use-file-tree-search";
import {
  buildSidebarSearchTree,
  buildSidebarTree,
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
import { useDetailSidebarLabels } from "@/hooks/use-detail-sidebar-labels";

const ROOT_PARENT_PATH = "";
const SOURCE_FILE_REFRESH_INTERVAL_MS = 2_000;
const SOURCE_FILE_FILTER_DEBOUNCE_MS = 300;
const DETAIL_SIDEBAR_MIN_WIDTH_PX = 256;
const DETAIL_SIDEBAR_MAX_WIDTH_PX = 512;
const DETAIL_SIDEBAR_DEFAULT_WIDTH_PX = DETAIL_SIDEBAR_MIN_WIDTH_PX;
type KnowledgeBaseDetailPageProps = {
  knowledgeBase: KnowledgeBase;
  onBack: () => void;
  onLogout: () => void;
};

type ActiveView = "file" | "processing";

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
  const activeViewRef = useRef<ActiveView>("processing");
  const sourceFilesRef = useRef<SourceFileRecord[]>([]);
  const isSourceFilePageLoadingRef = useRef(false);
  const sourceFileRefreshIntervalMsRef = useRef(SOURCE_FILE_REFRESH_INTERVAL_MS);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("processing");
  const [treePages, setTreePages] = useState<Record<string, TreePageState>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedFileTitle, setSelectedFileTitle] = useState("");
  const [selectedSourceFileId, setSelectedSourceFileId] = useState<string | null>(null);
  const [selectedFileRelationships, setSelectedFileRelationships] = useState<NonNullable<SourceFileRecord["graphSummary"]>["relationships"]>([]);
  const [previewHtml, setPreviewHtml] = useState("");
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
  const [publicUrls, setPublicUrls] = useState<KnowledgeBasePublicUrls | null>(null);
  const [copiedUrl, setCopiedUrl] = useState("");
  const [detailSidebarWidth, setDetailSidebarWidth] = useState(DETAIL_SIDEBAR_DEFAULT_WIDTH_PX);
  const fileTreeSearch = useFileTreeSearch(knowledgeBase.id);
  const handleDeleteSourceFileTasks = useSourceFileTaskDeletionHandler({
    knowledgeBaseId: knowledgeBase.id,
    sourceFilePageStateRef,
    setRetryingSourceFileId,
    loadSourceFiles,
    loadProcessingSummary
  });
  const directoryDeletion = useSourceDirectoryDeletion({
    knowledgeBaseId: knowledgeBase.id,
    selectedFilePath,
    setTreePages,
    setExpandedDirectories,
    clearSelectedFile,
    refreshProcessingSummary: loadProcessingSummary
  });
  const resourceEditing = useDetailResourceEditing({
    knowledgeBaseId: knowledgeBase.id,
    selectedSourceFileId,
    refresh: async () => {
      await Promise.all([refreshGeneratedFiles(), loadFirstSourceFilePage()]);
    },
    reopen: openPreviewPath
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
  const sidebarProviderStyle = useMemo(
    () =>
      ({
        "--sidebar-width": `${detailSidebarWidth}px`
      }) as CSSProperties,
    [detailSidebarWidth]
  );

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    sourceFilesRef.current = sourceFiles;
  }, [sourceFiles]);

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
    setPublicUrls(null);
    setCopiedUrl("");
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
    void loadPublicUrls();
  }, [knowledgeBase.id]);

  useEffect(() => {
    let timeoutId: number | null = null;
    let disposed = false;

    const canRefresh = () =>
      shouldScheduleSourceFileRefresh({
        activeView: activeViewRef.current,
        isVisible: document.visibilityState === "visible",
        sourceFiles: sourceFilesRef.current
      }) && !isSourceFilePageLoadingRef.current;

    const schedule = () => {
      if (disposed) {
        return;
      }
      const refreshIntervalMs = sourceFileRefreshIntervalMsRef.current;
      timeoutId = window.setTimeout(() => {
        if (canRefresh()) {
          void loadSourceFiles({ pageState: sourceFilePageStateRef.current });
        }
        schedule();
      }, refreshIntervalMs);
    };

    const handleVisibilityChange = () => {
      if (canRefresh()) {
        void loadSourceFiles({ pageState: sourceFilePageStateRef.current });
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    schedule();

    return () => {
      disposed = true;
      if (sourceFileFilterTimeoutRef.current !== null) {
        window.clearTimeout(sourceFileFilterTimeoutRef.current);
        sourceFileFilterTimeoutRef.current = null;
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [knowledgeBase.id]);

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

    const page = await fetchKnowledgeBaseFileTree({
      knowledgeBaseId: knowledgeBase.id,
      ...(input.parentPath ? { parentPath: input.parentPath } : {}),
      cursor: currentCursor
    });

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

    if (open && !treePages[node.logicalPath]) {
      await loadFileTree({ parentPath: node.logicalPath, replace: true });
    }
  }

  async function handleSelectFile(node: AdminSidebarTreeNode) {
    await openPreviewPath(node.logicalPath, node.name);
  }

  async function openPreviewPath(logicalPath: string, title: string) {
    setActiveView("file");
    setSelectedFilePath(logicalPath);
    setSelectedFileTitle(title);

    const detail = await fetchKnowledgeBaseFileDetail({
      knowledgeBaseId: knowledgeBase.id,
      path: logicalPath
    });

    if (!detail) {
      setSelectedFileRelationships([]);
      return;
    }

    setSelectedFileRelationships(detail.relationships);
    setSelectedSourceFileId(detail.file.sourceFileId);

    if (detail.file.contentType.includes("markdown") || logicalPath.endsWith(".md")) {
      setPreviewHtml(renderMarkdownPreview(detail.content, logicalPath));
      return;
    }

    setPreviewHtml(`<pre>${escapeHtml(detail.content)}</pre>`);
  }

  function clearSelectedFile() {
    setSelectedFilePath("");
    setSelectedFileTitle("");
    setSelectedFileRelationships([]);
    setSelectedSourceFileId(null);
    setPreviewHtml("");
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
      } catch {
        if (requestId !== sourceFileRequestIdRef.current) {
          return;
        }
        const nextPageState = createInitialCursorPageState();

        sourceFilePageStateRef.current = nextPageState;
        setSourceFilePageState(nextPageState);
        setSourceFiles([]);
        setSourceFileError("pagination.expired");

        if (input.pageState.currentCursor) {
          try {
            page = await listSourceFiles({
              knowledgeBaseId: knowledgeBase.id,
              cursor: nextPageState.currentCursor,
              ...(hasActiveSourceFileFilters(filters) ? { filters } : {})
            });
            if (requestId === sourceFileRequestIdRef.current) {
              await applySourceFilePage(nextPageState, page);
            }
          } catch {
            setSourceFiles([]);
          }
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
      loadPublicUrls()
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

  async function loadPublicUrls() {
    setPublicUrls(await fetchKnowledgeBasePublicUrls({ knowledgeBaseId: knowledgeBase.id }));
  }

  async function loadProcessingSummary() {
    setProcessingSummary(
      await fetchKnowledgeBaseProcessingSummary({ knowledgeBaseId: knowledgeBase.id })
    );
  }

  async function handleCopy(url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(url);
  }

  async function handleDeleteFile() {
    const target = deleteFileTarget;

    if (!target) {
      return;
    }

    setDeleteFileError("");
    setSourceFileError("");
    setActiveView("processing");
    setDeleteFileTarget(null);
    setIsDeletingFile(true);
    const result = await deleteKnowledgeBaseFile({
      knowledgeBaseId: knowledgeBase.id,
      path: target.logicalPath
    });
    setIsDeletingFile(false);

    if ("messageKey" in result) {
      setSourceFileError(result.messageKey);
      return;
    }

    if (selectedFilePath === target.logicalPath) {
      clearSelectedFile();
    }

    await loadFirstSourceFilePage();
    await refreshGeneratedFiles();
  }

  return (
    <SidebarProvider style={sidebarProviderStyle}>
      <AppSidebar
        appName={t("app.name")}
        knowledgeBaseName={knowledgeBase.name}
        labels={sidebarLabels}
        activeView={activeView}
        tree={sidebarTree}
        rootNextCursor={rootTreePage?.nextCursor ?? null}
        rootLoading={Boolean(rootTreePage?.isLoading)}
        sourceFiles={sourceFiles}
        onBack={onBack}
        onLogout={onLogout}
        onOpenProcessing={() => setActiveView("processing")}
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
          statusMessage: fileTreeSearch.errorMessageKey ? t(fileTreeSearch.errorMessageKey) : null,
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
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger aria-label={t("detail.toggleSidebar")} />
            <Separator orientation="vertical" className="h-4" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {activeView === "processing"
                  ? t("tasks.title")
                  : selectedFileTitle || selectedFilePath || t("result.preview")}
              </p>
              <p className="truncate text-xs text-muted-foreground">{knowledgeBase.name}</p>
            </div>
          </div>
          <LanguageSwitch />
        </header>
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden p-4">
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
              errorMessageKey={sourceFileError}
              retryingSourceFileId={retryingSourceFileId}
              onRetrySourceFile={(sourceFile) => void handleRetrySourceFile(sourceFile)}
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
          ) : (
            <FilePreviewPanel
              copiedUrl={copiedUrl}
              previewHtml={previewHtml}
              publicUrls={publicUrls}
              relationships={selectedFileRelationships}
              selectedFileTitle={selectedFileTitle}
              selectedFilePath={selectedFilePath}
              onCopy={(url) => void handleCopy(url)}
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
