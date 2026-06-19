import { useTranslation } from "react-i18next";
import { UploadIcon } from "lucide-react";
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
import type { SourceFileRecord } from "@/lib/admin-api";

type SourceFileProgressPanelProps = {
  sourceFiles: SourceFileRecord[];
  pagination: {
    hasNext: boolean;
    hasPrevious: boolean;
    isLoading: boolean;
    pageNumber: number;
  };
  onNextPage: () => void;
  onPreviousPage: () => void;
  onUpload: () => void;
  errorMessageKey?: string;
  retryingSourceFileId?: string | null | undefined;
  onRetrySourceFile: (sourceFile: SourceFileRecord) => void;
  onOpenGeneratedFile: (sourceFile: SourceFileRecord) => void;
};

export function SourceFileProgressPanel({
  sourceFiles,
  pagination,
  onNextPage,
  onPreviousPage,
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
        <CardAction>
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
