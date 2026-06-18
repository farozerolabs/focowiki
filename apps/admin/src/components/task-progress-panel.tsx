import { useTranslation } from "react-i18next";
import { UploadIcon } from "lucide-react";
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
  sourceFileCursor: string | null;
  onLoadMore: () => void;
  onUpload: () => void;
  errorMessageKey?: string;
  retryingSourceFileId?: string | null | undefined;
  onRetrySourceFile: (sourceFile: SourceFileRecord) => void;
};

export function SourceFileProgressPanel({
  sourceFiles,
  sourceFileCursor,
  onLoadMore,
  onUpload,
  errorMessageKey,
  retryingSourceFileId,
  onRetrySourceFile
}: SourceFileProgressPanelProps) {
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
          {errorMessageKey ? (
            <Alert variant="destructive">
              <AlertTitle>{t(errorMessageKey)}</AlertTitle>
            </Alert>
          ) : null}
          <SourceFileDataTable
            sourceFiles={sourceFiles}
            retryingSourceFileId={retryingSourceFileId}
            onRetrySourceFile={onRetrySourceFile}
          />
          {sourceFileCursor ? (
            <Button type="button" variant="outline" onClick={onLoadMore}>
              {t("home.loadMore")}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
