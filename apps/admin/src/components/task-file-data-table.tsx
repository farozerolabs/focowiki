import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { formatDisplayFileName } from "@/lib/display-file-name";
import type { SourceFileRecord, UploadTaskDetail } from "@/lib/admin-api";
import { formatTaskTime } from "./task-table-formatters";

type TaskFileDataTableProps = {
  taskId: string;
  detail: UploadTaskDetail | null | undefined;
  isLoading: boolean;
  error: string | null | undefined;
  onLoadMore: () => void;
};

export function TaskFileDataTable({
  taskId,
  detail,
  isLoading,
  error,
  onLoadMore
}: TaskFileDataTableProps) {
  const { i18n, t } = useTranslation();
  const files = detail?.sourceFiles.items ?? [];
  const phaseSummary = formatPhaseSummary(detail?.phaseDetails.items ?? [], t);

  if (isLoading && !detail) {
    return <p className="p-3 text-sm text-muted-foreground">{t("home.loading")}</p>;
  }

  if (error) {
    return <p className="p-3 text-sm text-destructive">{t(error)}</p>;
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">{t("tasks.internalPhases")}</p>
        <p className="truncate text-sm">{phaseSummary}</p>
      </div>
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("tasks.noTaskFiles")}</p>
      ) : (
        <Table
          className="min-w-[56rem]"
          aria-label={t("tasks.filesTableLabel", {
            id: taskId
          })}
        >
          <TableHeader>
            <TableRow>
              <TableHead>{t("tasks.filesTable.status")}</TableHead>
              <TableHead>{t("tasks.filesTable.fileName")}</TableHead>
              <TableHead>{t("tasks.filesTable.fileId")}</TableHead>
              <TableHead>{t("tasks.filesTable.stage")}</TableHead>
              <TableHead>{t("tasks.filesTable.startedAt")}</TableHead>
              <TableHead>{t("tasks.filesTable.endedAt")}</TableHead>
              <TableHead>{t("tasks.filesTable.error")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((file) => (
              <TableRow key={file.id} data-testid={`upload-task-file-row-${taskId}-${file.id}`}>
                <TableCell>{formatFileStatus(file, t)}</TableCell>
                <TableCell>
                  <span className="block max-w-72 truncate">
                    {formatDisplayFileName(file.originalName)}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="block max-w-48 truncate text-muted-foreground">{file.id}</span>
                </TableCell>
                <TableCell>{formatFileStage(file, t)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatTaskTime(
                    file.processingStartedAt ?? file.createdAt,
                    i18n.language,
                    t("tasks.notRecorded")
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatTaskTime(
                    file.processingEndedAt,
                    i18n.language,
                    t("tasks.notRecorded")
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {file.processingErrorCode ?? t("tasks.noError")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {detail?.sourceFiles.nextCursor ? (
        <Button type="button" variant="outline" size="sm" onClick={onLoadMore} disabled={isLoading}>
          {isLoading ? t("home.loading") : t("tasks.loadMoreFiles")}
        </Button>
      ) : null}
    </div>
  );
}

function formatPhaseSummary(
  phases: UploadTaskDetail["phaseDetails"]["items"],
  t: ReturnType<typeof useTranslation>["t"]
) {
  if (phases.length === 0) {
    return t("tasks.emptyPhases");
  }

  return phases.map((phase) => t(phase.messageKey)).join(" / ");
}

function formatFileStatus(file: SourceFileRecord, t: ReturnType<typeof useTranslation>["t"]) {
  return t(`tasks.fileStatus.${file.processingStatus ?? "completed"}`);
}

function formatFileStage(file: SourceFileRecord, t: ReturnType<typeof useTranslation>["t"]) {
  const stage = file.processingStage ?? "release_activation";

  return t(`tasks.phase.${stage.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())}`);
}
