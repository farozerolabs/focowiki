import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { CopyIcon } from "lucide-react";
import { AppSidebar, type AdminSidebarTreeNode } from "@/components/app-sidebar";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { SourceFileProgressPanel } from "@/components/task-progress-panel";
import { UploadSourceDialog } from "@/components/upload-source-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
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
  type BundleTreeEntry,
  type KnowledgeBasePublicUrls,
  type KnowledgeBase,
  type ProcessingSummary,
  type SourceFilePage,
  type SourceFileRecord
} from "@/lib/admin-api";

const ROOT_PARENT_PATH = "";
const SOURCE_FILE_REFRESH_INTERVAL_MS = 2_000;

type KnowledgeBaseDetailPageProps = {
  knowledgeBase: KnowledgeBase;
  onBack: () => void;
  onLogout: () => void;
};

type TreePageState = {
  items: BundleTreeEntry[];
  nextCursor: string | null;
  isLoading: boolean;
};

type ActiveView = "file" | "processing";

export function KnowledgeBaseDetailPage({
  knowledgeBase,
  onBack,
  onLogout
}: KnowledgeBaseDetailPageProps) {
  const { t } = useTranslation();
  const sourceFileRefreshSnapshotsRef = useRef<Map<string, SourceFileRefreshSnapshot>>(new Map());
  const sourceFilePageStateRef = useRef<CursorPageState>(createInitialCursorPageState());
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
  const [previewHtml, setPreviewHtml] = useState("");
  const [deleteFileTarget, setDeleteFileTarget] = useState<AdminSidebarTreeNode | null>(null);
  const [deleteFileError, setDeleteFileError] = useState("");
  const [isDeletingFile, setIsDeletingFile] = useState(false);
  const [sourceFiles, setSourceFiles] = useState<SourceFileRecord[]>([]);
  const [sourceFilePageState, setSourceFilePageState] = useState<CursorPageState>(
    createInitialCursorPageState
  );
  const [isSourceFilePageLoading, setIsSourceFilePageLoading] = useState(false);
  const [sourceFileError, setSourceFileError] = useState("");
  const [retryingSourceFileId, setRetryingSourceFileId] = useState<string | null>(null);
  const [processingSummary, setProcessingSummary] = useState<ProcessingSummary | null>(null);
  const [publicUrls, setPublicUrls] = useState<KnowledgeBasePublicUrls | null>(null);
  const [copiedUrl, setCopiedUrl] = useState("");

  const rootTreePage = treePages[ROOT_PARENT_PATH];
  const sidebarTree = useMemo(
    () => buildSidebarTree(treePages, expandedDirectories, selectedFilePath, ROOT_PARENT_PATH),
    [expandedDirectories, selectedFilePath, treePages]
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
    setSelectedFilePath("");
    setSelectedFileTitle("");
    setPreviewHtml("");
    setDeleteFileTarget(null);
    setDeleteFileError("");
    setIsDeletingFile(false);
    setSourceFiles([]);
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
    sourceFileRefreshSnapshotsRef.current = new Map();
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
      return;
    }

    if (detail.file.contentType.includes("markdown") || logicalPath.endsWith(".md")) {
      setPreviewHtml(renderMarkdownPreview(detail.content));
      return;
    }

    setPreviewHtml(`<pre>${escapeHtml(detail.content)}</pre>`);
  }

  async function loadSourceFiles(input: { pageState: CursorPageState }) {
    if (isSourceFilePageLoadingRef.current) {
      return;
    }
    isSourceFilePageLoadingRef.current = true;
    setIsSourceFilePageLoading(true);
    try {
      let page: SourceFilePage;

      try {
        page = await listSourceFiles({
          knowledgeBaseId: knowledgeBase.id,
          cursor: input.pageState.currentCursor
        });
      } catch {
        const nextPageState = createInitialCursorPageState();

        sourceFilePageStateRef.current = nextPageState;
        setSourceFilePageState(nextPageState);
        setSourceFiles([]);
        setSourceFileError("pagination.expired");

        if (input.pageState.currentCursor) {
          try {
            page = await listSourceFiles({
              knowledgeBaseId: knowledgeBase.id,
              cursor: nextPageState.currentCursor
            });
            await applySourceFilePage(nextPageState, page);
          } catch {
            setSourceFiles([]);
          }
        }
        return;
      }

      await applySourceFilePage(input.pageState, page);
      await loadProcessingSummary();
      setSourceFileError("");
    } finally {
      isSourceFilePageLoadingRef.current = false;
      setIsSourceFilePageLoading(false);
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

  async function loadFirstSourceFilePage() {
    const nextPageState = createInitialCursorPageState();

    sourceFilePageStateRef.current = nextPageState;
    setSourceFilePageState(nextPageState);
    await loadSourceFiles({ pageState: nextPageState });
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
      setSelectedFilePath("");
      setSelectedFileTitle("");
      setPreviewHtml("");
    }

    await loadFirstSourceFilePage();
    await refreshGeneratedFiles();
  }

  return (
    <SidebarProvider>
      <AppSidebar
        appName={t("app.name")}
        knowledgeBaseName={knowledgeBase.name}
        labels={{
          back: t("detail.back"),
          files: t("result.fileTree"),
          uploadProgress: t("tasks.title"),
          loadMore: t("home.loadMore"),
          logout: t("auth.logout"),
          running: t("tasks.runningShort"),
          ended: t("tasks.endedShort"),
          deleteFile: t("delete.action"),
          fileActions: t("delete.fileMenu"),
          emptyFiles: t("detail.emptyFiles"),
          loadingFiles: t("detail.loadingFiles")
        }}
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
        onToggleDirectory={(node, open) => void handleToggleDirectory(node, open)}
        onLoadMoreTree={(parentPath) => void loadFileTree({ parentPath, replace: false })}
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
              errorMessageKey={sourceFileError}
              retryingSourceFileId={retryingSourceFileId}
              onRetrySourceFile={(sourceFile) => void handleRetrySourceFile(sourceFile)}
              onOpenGeneratedFile={(sourceFile) => {
                const generatedFilePath = sourceFile.generatedFilePath;
                if (generatedFilePath) {
                  void (async () => {
                    await refreshGeneratedFiles();
                    await openPreviewPath(generatedFilePath, generatedFilePath.split("/").at(-1) ?? sourceFile.originalName);
                  })();
                }
              }}
            />
          ) : (
            <FilePreviewPanel
              copiedUrl={copiedUrl}
              previewHtml={previewHtml}
              publicUrls={publicUrls}
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
      <AlertDialog
        open={Boolean(deleteFileTarget)}
        onOpenChange={(open) => !open && !isDeletingFile && setDeleteFileTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete.fileTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("delete.fileDescription", {
                name: deleteFileTarget?.name ?? ""
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteFileError ? (
            <Alert variant="destructive">
              <AlertTitle>{t(deleteFileError)}</AlertTitle>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingFile}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeletingFile}
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteFile();
              }}
            >
              {isDeletingFile ? t("delete.deleting") : t("delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
  );
}

function FilePreviewPanel({
  copiedUrl,
  previewHtml,
  publicUrls,
  selectedFileTitle,
  selectedFilePath,
  onCopy,
  onOpenPreviewPath
}: {
  copiedUrl: string;
  previewHtml: string;
  publicUrls: KnowledgeBasePublicUrls | null;
  selectedFileTitle: string;
  selectedFilePath: string;
  onCopy: (url: string) => void;
  onOpenPreviewPath: (path: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const selectedPublicUrl =
    publicUrls && selectedFilePath ? buildSelectedFilePublicUrl(publicUrls.index, selectedFilePath) : null;
  const copyUrl = selectedPublicUrl ?? publicUrls?.index ?? null;

  function handlePreviewClick(event: MouseEvent<HTMLElement>) {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    const control = target.closest<HTMLButtonElement>("button[data-preview-path]");
    const previewPath = control?.dataset.previewPath;
    const previewTitle = control?.textContent?.trim();

    if (!previewPath) {
      return;
    }

    event.preventDefault();
    onOpenPreviewPath(previewPath, previewTitle || previewPath);
  }

  return (
    <Card className="min-h-[calc(100svh-5.5rem)] min-w-0">
      <CardHeader>
        <CardTitle>{selectedFileTitle || selectedFilePath || t("detail.noFileSelected")}</CardTitle>
        <CardDescription>{t("result.preview")}</CardDescription>
        {copyUrl ? (
          <CardAction>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t(selectedFilePath ? "result.copyFile" : "result.copyIndex")}
              onClick={() => onCopy(copyUrl)}
            >
              <CopyIcon />
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {copiedUrl ? <p className="mb-3 text-sm text-muted-foreground">{t("result.copied")}</p> : null}
        {previewHtml ? (
          <article
            className="prose prose-sm max-w-none text-foreground"
            onClick={handlePreviewClick}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : (
          <div className="flex min-h-80 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            {t("detail.noFileSelected")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function buildSelectedFilePublicUrl(indexUrl: string, logicalPath: string): string {
  const url = new URL(indexUrl);
  url.searchParams.set("path", logicalPath);
  return url.toString();
}

function buildSidebarTree(
  treePages: Record<string, TreePageState>,
  expandedDirectories: Set<string>,
  selectedFilePath: string,
  parentPath: string
): AdminSidebarTreeNode[] {
  const page = treePages[parentPath];

  if (!page) {
    return [];
  }

  return page.items.map((entry) => ({
    id: entry.id,
    name: entry.name,
    logicalPath: entry.logicalPath,
    entryType: entry.entryType,
    children:
      entry.entryType === "directory"
        ? buildSidebarTree(treePages, expandedDirectories, selectedFilePath, entry.logicalPath)
        : [],
    isExpanded: expandedDirectories.has(entry.logicalPath),
    isActive: selectedFilePath === entry.logicalPath,
    nextCursor: entry.entryType === "directory" ? treePages[entry.logicalPath]?.nextCursor ?? null : null,
    deletable: Boolean(entry.deletable)
  }));
}
