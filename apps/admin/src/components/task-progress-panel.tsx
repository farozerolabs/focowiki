import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import { RefreshCwIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { CursorPaginationControls } from "@/components/cursor-pagination-controls";
import { SourceFileActiveFilterSummary } from "@/components/source-file-filter-controls";
import { SourceFileDataTable } from "@/components/task-phase-data-table";
import { Alert, AlertTitle } from "@/components/ui/alert";
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { showAdminToast } from "@/hooks/use-admin-toast";
import type {
  ApiFailure,
  ProcessingSummary,
  SourceFileRecord,
  SourceFileTaskDeletionResponse,
  WorkerQueueSummary
} from "@/lib/admin-api";
import type { SourceFileListFilters } from "@/lib/source-file-list-filters";
import { getSelectableSourceFileIds } from "@/lib/source-file-task-deletion";

type SourceFileProgressPanelProps = {
  sourceFiles: SourceFileRecord[];
  filters: SourceFileListFilters;
  hasActiveFilters: boolean;
  summary: ProcessingSummary | null;
  pagination: {
    hasNext: boolean;
    hasPrevious: boolean;
    isLoading: boolean;
    pageNumber: number;
  };
  onNextPage: () => void;
  onPreviousPage: () => void;
  onRefresh: () => void;
  onUpload: () => void;
  onFiltersChange: (filters: SourceFileListFilters) => void;
  onClearFilters: () => void;
  errorMessageKey?: string;
  retryingSourceFileId?: string | null | undefined;
  onRetrySourceFile: (sourceFile: SourceFileRecord) => void;
  onOpenGeneratedFile: (sourceFile: SourceFileRecord) => void;
  onDeleteSourceFileTasks: (
    sourceFileIds: string[]
  ) => Promise<SourceFileTaskDeletionResponse | ApiFailure>;
};

export function SourceFileProgressPanel({
  sourceFiles,
  filters,
  hasActiveFilters,
  summary,
  pagination,
  onNextPage,
  onPreviousPage,
  onRefresh,
  onUpload,
  onFiltersChange,
  onClearFilters,
  errorMessageKey,
  retryingSourceFileId,
  onRetrySourceFile,
  onOpenGeneratedFile,
  onDeleteSourceFileTasks
}: SourceFileProgressPanelProps) {
  const { t } = useTranslation();
  const [selectedSourceFileIds, setSelectedSourceFileIds] = useState<Set<string>>(new Set());
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeletingTasks, setIsDeletingTasks] = useState(false);
  const selectableCurrentPageIds = useMemo(
    () => getSelectableSourceFileIds(sourceFiles),
    [sourceFiles]
  );
  const selectedCount = selectedSourceFileIds.size;

  useEffect(() => {
    setSelectedSourceFileIds(new Set());
  }, [sourceFiles, filters, pagination.pageNumber]);

  function handleToggleCurrentPageSelection(checked: boolean) {
    setSelectedSourceFileIds(checked ? new Set(selectableCurrentPageIds) : new Set());
  }

  function handleToggleSourceFileSelection(sourceFileId: string, checked: boolean) {
    setSelectedSourceFileIds((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(sourceFileId);
      } else {
        next.delete(sourceFileId);
      }

      return next;
    });
  }

  async function handleDeleteSelectedTasks() {
    const sourceFileIds = [...selectedSourceFileIds];

    if (sourceFileIds.length === 0) {
      return;
    }

    setIsDeletingTasks(true);
    try {
      const result = await onDeleteSourceFileTasks(sourceFileIds);

      if ("messageKey" in result) {
        showAdminToast({
          title: t("tasks.deleteToast.failedTitle"),
          description: t(result.messageKey),
          variant: "destructive"
        });
        return;
      }

      setSelectedSourceFileIds(new Set());
      setIsDeleteDialogOpen(false);
      showAdminToast(createTaskDeletionToast(result, t));
    } catch {
      showAdminToast({
        title: t("tasks.deleteToast.failedTitle"),
        description: t("tasks.deleteToast.networkFailure"),
        variant: "destructive"
      });
    } finally {
      setIsDeletingTasks(false);
    }
  }

  return (
    <>
      <Card className="min-h-[calc(100svh-5.5rem)] min-w-0" data-testid="source-file-progress-panel">
        <CardHeader>
          <CardTitle>{t("tasks.title")}</CardTitle>
          <CardAction className="flex gap-2">
            <Button type="button" variant="outline" onClick={onRefresh} disabled={pagination.isLoading}>
              <RefreshCwIcon data-icon="inline-start" />
              {t("tasks.refresh")}
            </Button>
            <Button type="button" variant="outline" onClick={onUpload}>
              <UploadIcon data-icon="inline-start" />
              {t("upload.upload")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="min-w-0">
          <div className="flex flex-col gap-3">
            {errorMessageKey ? (
              <Alert variant="destructive">
                <AlertTitle>{t(errorMessageKey)}</AlertTitle>
              </Alert>
            ) : null}
            {summary ? <ProcessingSummaryStrip summary={summary} /> : null}
            <SourceFileActiveFilterSummary filters={filters} onClearAll={onClearFilters} />
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {selectedCount > 0
                  ? t("tasks.selection.selectedCount", { count: selectedCount })
                  : t("tasks.selection.currentPageOnly")}
              </p>
              <Button
                type="button"
                variant="destructive"
                disabled={selectedCount === 0 || isDeletingTasks}
                onClick={() => setIsDeleteDialogOpen(true)}
              >
                <Trash2Icon data-icon="inline-start" />
                {t("tasks.deleteSelected")}
              </Button>
            </div>
            <SourceFileDataTable
              sourceFiles={sourceFiles}
              filters={filters}
              hasActiveFilters={hasActiveFilters}
              retryingSourceFileId={retryingSourceFileId}
              selectedSourceFileIds={selectedSourceFileIds}
              onToggleCurrentPageSelection={handleToggleCurrentPageSelection}
              onToggleSourceFileSelection={handleToggleSourceFileSelection}
              onFiltersChange={onFiltersChange}
              onClearFilters={onClearFilters}
              onRetrySourceFile={onRetrySourceFile}
              onOpenGeneratedFile={onOpenGeneratedFile}
            />
            <CursorPaginationControls
              labels={{
                currentPage: t("pagination.currentPage", { page: pagination.pageNumber }),
                next: t("pagination.next"),
                previous: t("pagination.previous")
              }}
              hasNext={pagination.hasNext}
              hasPrevious={pagination.hasPrevious}
              isLoading={pagination.isLoading}
              onNext={onNextPage}
              onPrevious={onPreviousPage}
            />
          </div>
        </CardContent>
      </Card>
      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => !isDeletingTasks && setIsDeleteDialogOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("tasks.deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("tasks.deleteDialog.description", { count: selectedCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingTasks}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeletingTasks}
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteSelectedTasks();
              }}
            >
              {isDeletingTasks ? t("tasks.deleteDialog.deleting") : t("tasks.deleteDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function createTaskDeletionToast(
  result: SourceFileTaskDeletionResponse,
  t: ReturnType<typeof useTranslation>["t"]
) {
  const changedCount = result.summary.deleted + result.summary.hidden;

  if (changedCount > 0 && result.summary.skipped > 0) {
    return {
      title: t("tasks.deleteToast.partialTitle"),
      description: t("tasks.deleteToast.partialDescription", {
        changed: changedCount,
        skipped: result.summary.skipped
      })
    };
  }

  if (changedCount > 0) {
    return {
      title: t("tasks.deleteToast.successTitle"),
      description: t("tasks.deleteToast.successDescription", { count: changedCount })
    };
  }

  return {
    title: t("tasks.deleteToast.skippedTitle"),
    description: t("tasks.deleteToast.skippedDescription", { count: result.summary.skipped }),
    variant: "destructive" as const
  };
}

function ProcessingSummaryStrip({ summary }: { summary: ProcessingSummary }) {
  const { t } = useTranslation();
  const sourceActive = activeCount(summary.sourceFileJobs);
  const publicationActive = activeCount(summary.publicationJobs);
  const progress = summary.publicationProgress;

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryItem
        label={t("tasks.summary.pendingDispatch")}
        value={t("tasks.summary.pendingCount", { count: summary.pendingDispatch.pendingCount })}
        detail={summary.pendingDispatch.paused
          ? t("tasks.summary.dispatchPaused")
          : summary.pendingDispatch.oldestPendingAt
            ? t("tasks.summary.oldestDirty", {
                time: new Date(summary.pendingDispatch.oldestPendingAt).toLocaleString()
              })
            : t("tasks.summary.noPendingDispatch")}
      />
      <SummaryItem
        label={t("tasks.summary.sourceQueue")}
        value={t("tasks.summary.activeCount", { count: sourceActive })}
        detail={formatQueueDetail(summary.sourceFileJobs, t)}
      />
      <SummaryItem
        label={t("tasks.summary.publicationQueue")}
        value={t("tasks.summary.activeCount", { count: publicationActive })}
        detail={progress.stage
          ? t("tasks.summary.publicationStage", {
              stage: progress.stage,
              processed: progress.processedImpactCount,
              total: progress.totalImpactCount
            })
          : formatQueueDetail(summary.publicationJobs, t)}
      />
      <SummaryItem
        label={t("tasks.summary.activeVisibility")}
        value={summary.activeGenerationId
          ? t("tasks.summary.activeGeneration")
          : t("tasks.summary.noActiveGeneration")}
        detail={progress.safeErrorCode
          ? t("tasks.summary.publicationFailed", { code: progress.safeErrorCode })
          : summary.activeGenerationId ?? t("tasks.summary.waitingForFirstGeneration")}
      />
    </div>
  );
}

function SummaryItem({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
      <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function activeCount(summary: WorkerQueueSummary): number {
  return summary.queuedCount + summary.runningCount;
}

function formatQueueDetail(
  summary: WorkerQueueSummary,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  const parts = [
    t("tasks.summary.queued", { count: summary.queuedCount }),
    t("tasks.summary.running", { count: summary.runningCount })
  ];

  if (summary.failedCount > 0) {
    parts.push(t("tasks.summary.failed", { count: summary.failedCount }));
  }
  if (summary.deadLetterCount > 0) {
    parts.push(t("tasks.summary.deadLetter", { count: summary.deadLetterCount }));
  }
  if (summary.oldestQueuedAgeSeconds !== null) {
    parts.push(t("tasks.summary.oldestQueuedAge", { seconds: summary.oldestQueuedAgeSeconds }));
  }

  return parts.join(" / ");
}
