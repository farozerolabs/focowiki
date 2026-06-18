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
import type { SourceFileRecord } from "@/lib/admin-api";
import { formatSourceFileTime } from "./task-table-formatters";

type SourceFileDataTableProps = {
  sourceFiles: SourceFileRecord[];
  retryingSourceFileId?: string | null | undefined;
  onRetrySourceFile?: ((sourceFile: SourceFileRecord) => void) | undefined;
};

export function SourceFileDataTable({
  sourceFiles,
  retryingSourceFileId,
  onRetrySourceFile
}: SourceFileDataTableProps) {
  const { i18n, t } = useTranslation();

  if (sourceFiles.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t("tasks.empty")}</p>;
  }

  return (
    <div className="overflow-hidden rounded-md border">
      <Table className="min-w-[72rem]" aria-label={t("tasks.title")}>
        <TableHeader>
          <TableRow>
            <TableHead>{t("tasks.filesTable.status")}</TableHead>
            <TableHead>{t("tasks.filesTable.fileName")}</TableHead>
            <TableHead>{t("tasks.filesTable.fileId")}</TableHead>
            <TableHead>{t("tasks.filesTable.stage")}</TableHead>
            <TableHead>{t("tasks.filesTable.model")}</TableHead>
            <TableHead>{t("tasks.filesTable.startedAt")}</TableHead>
            <TableHead>{t("tasks.filesTable.endedAt")}</TableHead>
            <TableHead>{t("tasks.filesTable.error")}</TableHead>
            <TableHead>{t("tasks.filesTable.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sourceFiles.map((file) => (
            <TableRow key={file.id} data-testid={`source-file-row-${file.id}`}>
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
                {formatModelInvocation(file, t)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatSourceFileTime(
                  file.processingStartedAt ?? file.createdAt,
                  i18n.language,
                  t("tasks.notRecorded")
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatSourceFileTime(file.processingEndedAt, i18n.language, t("tasks.notRecorded"))}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {file.processingErrorCode ?? t("tasks.noError")}
              </TableCell>
              <TableCell>
                {file.processingStatus === "failed" && onRetrySourceFile ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={retryingSourceFileId === file.id}
                    onClick={() => onRetrySourceFile(file)}
                  >
                    {retryingSourceFileId === file.id
                      ? t("tasks.retryingFile")
                      : t("tasks.retryFile")}
                  </Button>
                ) : (
                  <span className="text-muted-foreground">{t("tasks.noAction")}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function formatFileStatus(file: SourceFileRecord, t: ReturnType<typeof useTranslation>["t"]) {
  return t(`tasks.fileStatus.${file.processingStatus ?? "completed"}`);
}

function formatFileStage(file: SourceFileRecord, t: ReturnType<typeof useTranslation>["t"]) {
  const stage = file.processingStage ?? "release_activation";

  return t(`tasks.phase.${stage.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())}`);
}

function formatModelInvocation(
  file: SourceFileRecord,
  t: ReturnType<typeof useTranslation>["t"]
) {
  const status = file.modelInvocationStatus;

  if (!status) {
    return t("tasks.notRecorded");
  }

  const parts = [
    file.modelInvocationModelName ?? t("tasks.notRecorded"),
    t(`tasks.modelStatus.${status}`)
  ];
  const duration = formatModelDuration(file.modelInvocationStartedAt, file.modelInvocationEndedAt);

  if (duration) {
    parts.push(duration);
  }
  if (file.modelInvocationWarningCount && file.modelInvocationWarningCount > 0) {
    parts.push(t("tasks.modelWarnings", { count: file.modelInvocationWarningCount }));
  }
  if (file.modelInvocationErrorCode) {
    parts.push(file.modelInvocationErrorCode);
  }

  return parts.join(" / ");
}

function formatModelDuration(startedAt: string | null | undefined, endedAt: string | null | undefined) {
  if (!startedAt || !endedAt) {
    return null;
  }

  const durationMs = Date.parse(endedAt) - Date.parse(startedAt);

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}
