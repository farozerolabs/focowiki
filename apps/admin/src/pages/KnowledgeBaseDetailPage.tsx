import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { CopyIcon, UploadIcon } from "lucide-react";
import { AppSidebar, type AdminSidebarTreeNode } from "@/components/app-sidebar";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { UploadTaskDataTable } from "@/components/task-phase-data-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { escapeHtml, renderMarkdownPreview } from "@/lib/markdown-preview";
import {
  fetchKnowledgeBaseFileDetail,
  fetchKnowledgeBaseFileTree,
  fetchKnowledgeBasePublicUrls,
  fetchUploadTaskDetail,
  listUploadTasks,
  uploadKnowledgeBaseSources,
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
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [uploadTask, setUploadTask] = useState<UploadTaskLifecycle | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("tasks");
  const [treePages, setTreePages] = useState<Record<string, TreePageState>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedFileTitle, setSelectedFileTitle] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [tasks, setTasks] = useState<UploadTaskLifecycle[]>([]);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const [taskDetailsById, setTaskDetailsById] = useState<Record<string, UploadTaskDetail | null>>({});
  const [publicUrls, setPublicUrls] = useState<KnowledgeBasePublicUrls | null>(null);
  const [copiedUrl, setCopiedUrl] = useState("");

  const selectedFileItems = selectedFiles ? Array.from(selectedFiles) : [];
  const rootTreePage = treePages[ROOT_PARENT_PATH];
  const sidebarTree = useMemo(
    () => buildSidebarTree(treePages, expandedDirectories, selectedFilePath, ROOT_PARENT_PATH),
    [expandedDirectories, selectedFilePath, treePages]
  );

  useEffect(() => {
    setSelectedFiles(null);
    setUploadError("");
    setUploadTask(null);
    setIsUploadDialogOpen(false);
    setActiveView("tasks");
    setTreePages({});
    setExpandedDirectories(new Set());
    setSelectedFilePath("");
    setSelectedFileTitle("");
    setPreviewHtml("");
    setTasks([]);
    setTaskCursor(null);
    setTaskDetailsById({});
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
  }, [knowledgeBase.id]);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsUploading(true);
    setUploadError("");
    setUploadTask(null);

    if (!selectedFiles) {
      setIsUploading(false);
      return;
    }

    const result = await uploadKnowledgeBaseSources({
      knowledgeBaseId: knowledgeBase.id,
      files: selectedFiles
    }).catch(() => ({ messageKey: "errors.uploadFailed" }));

    if ("messageKey" in result) {
      setIsUploading(false);
      setUploadError(result.messageKey);
      return;
    }

    setUploadTask(result.task);
    setActiveView("tasks");
    setIsUploadDialogOpen(false);
    setSelectedFiles(null);
    setIsUploading(false);
    await loadTasks({ replace: true });
  }

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
    await loadTaskDetails(page.items, { replace: input.replace });

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

  async function loadTaskDetails(pageTasks: UploadTaskLifecycle[], input: { replace: boolean }) {
    const entries = await Promise.all(
      pageTasks.map(async (task) => {
        const detail = await fetchUploadTaskDetail({
          knowledgeBaseId: knowledgeBase.id,
          taskId: task.id
        });

        return [task.id, detail] as const;
      })
    );

    setTaskDetailsById((current) => ({
      ...(input.replace ? {} : current),
      ...Object.fromEntries(entries)
    }));
  }

  async function loadPublicUrls() {
    setPublicUrls(await fetchKnowledgeBasePublicUrls({ knowledgeBaseId: knowledgeBase.id }));
  }

  async function handleCopy(url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(url);
  }

  function handleSourceFilesChange(files: FileList | null) {
    setSelectedFiles(files);
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
          ended: t("tasks.endedShort")
        }}
        activeView={activeView}
        tree={sidebarTree}
        rootNextCursor={rootTreePage?.nextCursor ?? null}
        tasks={tasks}
        onBack={onBack}
        onLogout={onLogout}
        onOpenTasks={() => setActiveView("tasks")}
        onOpenFile={(node) => void handleSelectFile(node)}
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
              onLoadMore={() => void loadTasks({ replace: false })}
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

      <Dialog open={isUploadDialogOpen} onOpenChange={(open) => !isUploading && setIsUploadDialogOpen(open)}>
        <DialogContent
          aria-describedby="upload-dialog-description"
          onPointerDownOutside={(event) => {
            if (isUploading) {
              event.preventDefault();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("upload.title")}</DialogTitle>
            <DialogDescription id="upload-dialog-description">
              {t("upload.description")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleUpload}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="source-files">{t("upload.selectFiles")}</FieldLabel>
                <label
                  htmlFor="source-files"
                  className={buttonVariants({
                    variant: "outline",
                    className: "relative cursor-pointer overflow-hidden"
                  })}
                >
                  <UploadIcon data-icon="inline-start" />
                  {t("upload.chooseFiles")}
                  <input
                    id="source-files"
                    type="file"
                    accept=".md"
                    multiple
                    className="absolute inset-0 cursor-pointer opacity-0"
                    aria-describedby="source-files-status"
                    onChange={(event) => handleSourceFilesChange(event.target.files)}
                  />
                </label>
                <div
                  id="source-files-status"
                  className="rounded-lg border bg-muted/40 p-2 text-sm text-muted-foreground"
                >
                  {selectedFileItems.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      <p>{t("upload.selectedFiles", { count: selectedFileItems.length })}</p>
                      <ul className="flex flex-col gap-1">
                        {selectedFileItems.map((file) => (
                          <li key={`${file.name}-${file.size}`} className="text-foreground">
                            {file.name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p>{t("upload.noFilesSelected")}</p>
                  )}
                </div>
              </Field>
              {uploadError ? (
                <Alert variant="destructive">
                  <AlertTitle>{t(uploadError)}</AlertTitle>
                </Alert>
              ) : null}
              {uploadTask ? (
                <Alert>
                  <AlertTitle>{t("tasks.running")}</AlertTitle>
                  <AlertDescription>{uploadTask.id}</AlertDescription>
                </Alert>
              ) : null}
              <Button type="submit" disabled={!selectedFiles?.length || isUploading}>
                {isUploading ? t("upload.uploading") : t("upload.upload")}
              </Button>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
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

function TaskProgressPanel({
  tasks,
  taskCursor,
  taskDetailsById,
  onLoadMore,
  onUpload
}: {
  tasks: UploadTaskLifecycle[];
  taskCursor: string | null;
  taskDetailsById: Record<string, UploadTaskDetail | null>;
  onLoadMore: () => void;
  onUpload: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Card className="min-h-[calc(100svh-5.5rem)] min-w-0">
      <CardHeader>
        <CardTitle>{t("tasks.title")}</CardTitle>
        <CardDescription>{t("tasks.description")}</CardDescription>
        <CardAction>
          <Button type="button" variant="outline" onClick={onUpload}>
            <UploadIcon data-icon="inline-start" />
            {t("upload.upload")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="min-w-0">
        <div className="flex flex-col gap-3">
          <UploadTaskDataTable tasks={tasks} taskDetailsById={taskDetailsById} />
          {taskCursor ? (
            <Button type="button" variant="outline" onClick={onLoadMore}>
              {t("home.loadMore")}
            </Button>
          ) : null}
        </div>
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
    nextCursor: entry.entryType === "directory" ? treePages[entry.logicalPath]?.nextCursor ?? null : null
  }));
}
