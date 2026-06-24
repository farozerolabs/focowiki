import { useTranslation } from "react-i18next";
import { RefreshCwIcon, UploadIcon } from "lucide-react";
import { CursorPaginationControls } from "@/components/cursor-pagination-controls";
import { SourceFileDataTable } from "@/components/task-phase-data-table";
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
import type { ProcessingSummary, SourceFileRecord, WorkerQueueSummary } from "@/lib/admin-api";

type SourceFileProgressPanelProps = {
  sourceFiles: SourceFileRecord[];
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
  errorMessageKey?: string;
  retryingSourceFileId?: string | null | undefined;
  onRetrySourceFile: (sourceFile: SourceFileRecord) => void;
  onOpenGeneratedFile: (sourceFile: SourceFileRecord) => void;
};

export function SourceFileProgressPanel({
  sourceFiles,
  summary,
  pagination,
  onNextPage,
  onPreviousPage,
  onRefresh,
  onUpload,
  errorMessageKey,
  retryingSourceFileId,
  onRetrySourceFile,
  onOpenGeneratedFile
}: SourceFileProgressPanelProps) {
  const { t } = useTranslation();

  return (
    <Card className="min-h-[calc(100svh-5.5rem)] min-w-0" data-testid="source-file-progress-panel">
      <CardHeader>
        <CardTitle>{t("tasks.title")}</CardTitle>
        <CardDescription>{t("tasks.description")}</CardDescription>
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
          <SourceFileDataTable
            sourceFiles={sourceFiles}
            retryingSourceFileId={retryingSourceFileId}
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
  );
}

function ProcessingSummaryStrip({ summary }: { summary: ProcessingSummary }) {
  const { t } = useTranslation();
  const sourceActive = activeCount(summary.sourceFileJobs);
  const publicationActive = activeCount(summary.publicationJobs);

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <SummaryItem
        label={t("tasks.summary.sourceQueue")}
        value={t("tasks.summary.activeCount", { count: sourceActive })}
        detail={formatQueueDetail(summary.sourceFileJobs, t)}
      />
      <SummaryItem
        label={t("tasks.summary.publicationQueue")}
        value={t("tasks.summary.activeCount", { count: publicationActive })}
        detail={formatQueueDetail(summary.publicationJobs, t)}
      />
      <SummaryItem
        label={t("tasks.summary.dirtyFiles")}
        value={t("tasks.summary.dirtyCount", { count: summary.dirtySourceFiles.count })}
        detail={
          summary.dirtySourceFiles.oldestDirtyAt
            ? t("tasks.summary.oldestDirty", {
                time: new Date(summary.dirtySourceFiles.oldestDirtyAt).toLocaleString()
              })
            : t("tasks.summary.noDirtyFiles")
        }
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
