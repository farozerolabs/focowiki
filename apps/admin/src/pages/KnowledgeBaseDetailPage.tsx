import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { CopyIcon } from "lucide-react";
import { AppSidebar, type AdminSidebarTreeNode } from "@/components/app-sidebar";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { TaskProgressPanel } from "@/components/task-progress-panel";
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
  deleteKnowledgeBaseFile,
  fetchKnowledgeBaseFileDetail,
  fetchKnowledgeBaseFileTree,
  fetchKnowledgeBasePublicUrls,
  fetchUploadTaskDetail,
  listUploadTasks,
  type BundleTreeEntry,
  type KnowledgeBasePublicUrls,
  type KnowledgeBase,
  type UploadTaskDetail,
  type UploadTaskLifecycle
} from "@/lib/admin-api";

const ROOT_PARENT_PATH = "";
const TASK_REFRESH_INTERVAL_MS = 2_000;

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

type ActiveView = "file" | "tasks";

export function KnowledgeBaseDetailPage({
  knowledgeBase,
  onBack,
  onLogout
}: KnowledgeBaseDetailPageProps) {
  const { t } = useTranslation();
  const hasRunningTasksRef = useRef(false);
  const loadedTreeParentsRef = useRef<Set<string>>(new Set());
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("tasks");
  const [treePages, setTreePages] = useState<Record<string, TreePageState>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedFileTitle, setSelectedFileTitle] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [deleteFileTarget, setDeleteFileTarget] = useState<AdminSidebarTreeNode | null>(null);
  const [deleteFileError, setDeleteFileError] = useState("");
  const [isDeletingFile, setIsDeletingFile] = useState(false);
  const [tasks, setTasks] = useState<UploadTaskLifecycle[]>([]);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const [taskDetailsById, setTaskDetailsById] = useState<Record<string, UploadTaskDetail | null>>({});
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set());
  const [loadingTaskDetailIds, setLoadingTaskDetailIds] = useState<Set<string>>(new Set());
  const [taskDetailErrorsById, setTaskDetailErrorsById] = useState<Record<string, string | null>>({});
  const [publicUrls, setPublicUrls] = useState<KnowledgeBasePublicUrls | null>(null);
  const [copiedUrl, setCopiedUrl] = useState("");

  const rootTreePage = treePages[ROOT_PARENT_PATH];
  const sidebarTree = useMemo(
    () => buildSidebarTree(treePages, expandedDirectories, selectedFilePath, ROOT_PARENT_PATH),
    [expandedDirectories, selectedFilePath, treePages]
  );

  useEffect(() => {
    setIsUploadDialogOpen(false);
    setActiveView("tasks");
    setTreePages({});
    setExpandedDirectories(new Set());
    setSelectedFilePath("");
    setSelectedFileTitle("");
    setPreviewHtml("");
    setDeleteFileTarget(null);
    setDeleteFileError("");
    setIsDeletingFile(false);
    setTasks([]);
    setTaskCursor(null);
    setTaskDetailsById({});
    setExpandedTaskIds(new Set());
    setLoadingTaskDetailIds(new Set());
    setTaskDetailErrorsById({});
    setPublicUrls(null);
    setCopiedUrl("");
    loadedTreeParentsRef.current = new Set();

    void loadFileTree({ parentPath: ROOT_PARENT_PATH, replace: true });
    void loadTasks({ replace: true });
    void loadPublicUrls();
  }, [knowledgeBase.id]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadTasks({ replace: true });
    }, TASK_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [expandedTaskIds, knowledgeBase.id]);

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

  async function loadTasks(input: { replace: boolean }) {
    const page = await listUploadTasks({
      knowledgeBaseId: knowledgeBase.id,
      cursor: input.replace ? null : taskCursor
    });
    const hasRunningTasks = page.items.some((task) => task.lifecycle === "running");
    const shouldRefreshGeneratedFiles = input.replace && hasRunningTasksRef.current && !hasRunningTasks;

    setTasks((current) => (input.replace ? page.items : [...current, ...page.items]));
    setTaskCursor(page.nextCursor);
    await refreshExpandedTaskDetails(page.items);

    if (input.replace) {
      hasRunningTasksRef.current = hasRunningTasks;
    }

    if (shouldRefreshGeneratedFiles) {
      await refreshGeneratedFiles();
    }
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

  async function refreshExpandedTaskDetails(pageTasks: UploadTaskLifecycle[]) {
    await Promise.all(
      pageTasks
        .filter((task) => expandedTaskIds.has(task.id))
        .map((task) => loadTaskDetail(task.id))
    );
  }

  async function loadTaskDetail(taskId: string) {
    setLoadingTaskDetailIds((current) => new Set(current).add(taskId));
    setTaskDetailErrorsById((current) => ({
      ...current,
      [taskId]: null
    }));

    try {
      const detail = await fetchUploadTaskDetail({
        knowledgeBaseId: knowledgeBase.id,
        taskId
      });

      if (!detail) {
        setTaskDetailErrorsById((current) => ({
          ...current,
          [taskId]: "errors.uploadFailed"
        }));
        return;
      }

      setTaskDetailsById((current) => ({
        ...current,
        [taskId]: detail
      }));
    } catch {
      setTaskDetailErrorsById((current) => ({
        ...current,
        [taskId]: "errors.uploadFailed"
      }));
    } finally {
      setLoadingTaskDetailIds((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  }

  async function handleToggleTask(taskId: string, open: boolean) {
    setExpandedTaskIds((current) => {
      const next = new Set(current);

      if (open) {
        next.add(taskId);
      } else {
        next.delete(taskId);
      }

      return next;
    });

    if (open && !taskDetailsById[taskId] && !loadingTaskDetailIds.has(taskId)) {
      await loadTaskDetail(taskId);
    }
  }

  async function loadMoreTaskSourceFiles(taskId: string) {
    const currentDetail = taskDetailsById[taskId];
    const sourceCursor = currentDetail?.sourceFiles.nextCursor;

    if (!sourceCursor) {
      return;
    }

    setLoadingTaskDetailIds((current) => new Set(current).add(taskId));
    setTaskDetailErrorsById((current) => ({
      ...current,
      [taskId]: null
    }));

    let nextDetail: UploadTaskDetail | null = null;

    try {
      nextDetail = await fetchUploadTaskDetail({
        knowledgeBaseId: knowledgeBase.id,
        taskId,
        sourceCursor
      });
    } catch {
      nextDetail = null;
    } finally {
      setLoadingTaskDetailIds((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }

    if (!nextDetail) {
      setTaskDetailErrorsById((current) => ({
        ...current,
        [taskId]: "errors.uploadFailed"
      }));
      return;
    }

    setTaskDetailsById((current) => {
      const previousDetail = current[taskId];

      if (!previousDetail) {
        return current;
      }

      return {
        ...current,
        [taskId]: {
          task: nextDetail.task,
          phaseDetails: previousDetail.phaseDetails,
          sourceFiles: {
            items: [...previousDetail.sourceFiles.items, ...nextDetail.sourceFiles.items],
            nextCursor: nextDetail.sourceFiles.nextCursor
          }
        }
      };
    });
  }

  async function loadPublicUrls() {
    setPublicUrls(await fetchKnowledgeBasePublicUrls({ knowledgeBaseId: knowledgeBase.id }));
  }

  async function handleCopy(url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(url);
  }

  async function handleDeleteFile() {
    if (!deleteFileTarget) {
      return;
    }

    setDeleteFileError("");
    setIsDeletingFile(true);
    const result = await deleteKnowledgeBaseFile({
      knowledgeBaseId: knowledgeBase.id,
      path: deleteFileTarget.logicalPath
    });
    setIsDeletingFile(false);

    if ("messageKey" in result) {
      setDeleteFileError(result.messageKey);
      return;
    }

    setTasks((current) => [result.task, ...current.filter((task) => task.id !== result.task.id)]);
    setActiveView("tasks");
    setDeleteFileTarget(null);

    if (selectedFilePath === deleteFileTarget.logicalPath) {
      setSelectedFilePath("");
      setSelectedFileTitle("");
      setPreviewHtml("");
    }

    await loadTasks({ replace: true });
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
          fileActions: t("delete.fileMenu")
        }}
        activeView={activeView}
        tree={sidebarTree}
        rootNextCursor={rootTreePage?.nextCursor ?? null}
        tasks={tasks}
        onBack={onBack}
        onLogout={onLogout}
        onOpenTasks={() => setActiveView("tasks")}
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
                {activeView === "tasks"
                  ? t("tasks.title")
                  : selectedFileTitle || selectedFilePath || t("result.preview")}
              </p>
              <p className="truncate text-xs text-muted-foreground">{knowledgeBase.name}</p>
            </div>
          </div>
          <LanguageSwitch />
        </header>
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden p-4">
          {activeView === "tasks" ? (
            <TaskProgressPanel
              tasks={tasks}
              taskCursor={taskCursor}
              taskDetailsById={taskDetailsById}
              expandedTaskIds={expandedTaskIds}
              loadingTaskDetailIds={loadingTaskDetailIds}
              taskDetailErrorsById={taskDetailErrorsById}
              onLoadMore={() => void loadTasks({ replace: false })}
              onLoadMoreTaskSourceFiles={(taskId) => void loadMoreTaskSourceFiles(taskId)}
              onToggleTask={(taskId, open) => void handleToggleTask(taskId, open)}
              onUpload={() => setIsUploadDialogOpen(true)}
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
          setActiveView("tasks");
          await loadTasks({ replace: true });
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
        {publicUrls ? (
          <CardAction>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t("result.copyIndex")}
              onClick={() => onCopy(publicUrls.index)}
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
