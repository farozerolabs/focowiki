import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SourceFileActionFilterHeader,
  SourceFileEndedFilterHeader,
  SourceFileErrorFilterHeader,
  SourceFileGeneratedFilterHeader,
  SourceFileIdFilterHeader,
  SourceFileModelFilterHeader,
  SourceFileNameFilterHeader,
  SourceFileStageFilterHeader,
  SourceFileStartedFilterHeader,
  SourceFileStatusFilterHeader
} from "@/components/source-file-filter-controls";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import type { SourceFileRecord } from "@/lib/admin-api";
import type { SourceFileListFilters } from "@/lib/source-file-list-filters";
import { isSourceFileTaskDeletionSelectable } from "@/lib/source-file-task-deletion";
import { formatSourceFileTime } from "./task-table-formatters";

type SourceFileDataTableProps = {
  sourceFiles: SourceFileRecord[];
  filters: SourceFileListFilters;
  hasActiveFilters: boolean;
  retryingSourceFileId?: string | null | undefined;
  selectedSourceFileIds: Set<string>;
  onFiltersChange: (filters: SourceFileListFilters) => void;
  onClearFilters: () => void;
  onToggleCurrentPageSelection: (checked: boolean) => void;
  onToggleSourceFileSelection: (sourceFileId: string, checked: boolean) => void;
  onRetrySourceFile?: ((sourceFile: SourceFileRecord) => void) | undefined;
  onOpenGeneratedFile?: ((sourceFile: SourceFileRecord) => void) | undefined;
};

const SOURCE_FILE_TABLE_COLUMNS = [
  "3rem",
  "7rem",
  "20rem",
  "17rem",
  "11rem",
  "20rem",
  "8rem",
  "12rem",
  "12rem",
  "12rem",
  "10rem"
];

export function SourceFileDataTable({
  sourceFiles,
  filters,
  hasActiveFilters,
  retryingSourceFileId,
  selectedSourceFileIds,
  onFiltersChange,
  onClearFilters,
  onToggleCurrentPageSelection,
  onToggleSourceFileSelection,
  onRetrySourceFile,
  onOpenGeneratedFile
}: SourceFileDataTableProps) {
  const { i18n, t } = useTranslation();
  const selectableSourceFileIds = sourceFiles
    .filter(isSourceFileTaskDeletionSelectable)
    .map((file) => file.id);
  const selectedSelectableCount = selectableSourceFileIds.filter((sourceFileId) =>
    selectedSourceFileIds.has(sourceFileId)
  ).length;
  const allCurrentPageSelected =
    selectableSourceFileIds.length > 0 && selectedSelectableCount === selectableSourceFileIds.length;
  const currentPageSelectionState =
    selectedSelectableCount > 0 && !allCurrentPageSelected ? "indeterminate" : allCurrentPageSelected;

  return (
    <div className="overflow-hidden rounded-md border">
      <Table className="min-w-[132rem] table-fixed" aria-label={t("tasks.title")}>
        <colgroup>
          {SOURCE_FILE_TABLE_COLUMNS.map((width, index) => (
            <col key={index} style={{ width }} />
          ))}
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Checkbox
                aria-label={t("tasks.selection.selectCurrentPage")}
                checked={currentPageSelectionState}
                disabled={selectableSourceFileIds.length === 0}
                onCheckedChange={(checked) => onToggleCurrentPageSelection(checked === true)}
              />
            </TableHead>
            <TableHead>
              <SourceFileStatusFilterHeader filters={filters} onFiltersChange={onFiltersChange} />
            </TableHead>
            <TableHead>
              <SourceFileNameFilterHeader filters={filters} onFiltersChange={onFiltersChange} />
            </TableHead>
            <TableHead>
              <SourceFileIdFilterHeader filters={filters} onFiltersChange={onFiltersChange} />
            </TableHead>
            <TableHead>
              <SourceFileStageFilterHeader filters={filters} onFiltersChange={onFiltersChange} />
            </TableHead>
            <TableHead>
              <SourceFileModelFilterHeader filters={filters} onFiltersChange={onFiltersChange} />
            </TableHead>
            <TableHead>
              <SourceFileGeneratedFilterHeader filters={filters} onFiltersChange={onFiltersChange} />
            </TableHead>
            <TableHead>
              <SourceFileStartedFilterHeader filters={filters} onFiltersChange={onFiltersChange} />
            </TableHead>
            <TableHead>
              <SourceFileEndedFilterHeader filters={filters} onFiltersChange={onFiltersChange} />
            </TableHead>
            <TableHead>
              <SourceFileErrorFilterHeader filters={filters} onFiltersChange={onFiltersChange} />
            </TableHead>
            <TableHead>
              <SourceFileActionFilterHeader filters={filters} onFiltersChange={onFiltersChange} />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sourceFiles.length === 0 ? (
            <TableRow>
              <TableCell colSpan={11}>
                <div className="flex flex-col gap-2 p-4 text-sm text-muted-foreground">
                  <span>{hasActiveFilters ? t("tasks.filters.noMatches") : t("tasks.empty")}</span>
                  {hasActiveFilters ? (
                    <Button type="button" variant="outline" size="sm" onClick={onClearFilters}>
                      {t("tasks.filters.clearAll")}
                    </Button>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ) : sourceFiles.map((file) => (
            <TableRow key={file.id} data-testid={`source-file-row-${file.id}`}>
              <TableCell>
                <Checkbox
                  aria-label={t("tasks.selection.selectRow", { name: file.relativePath })}
                  checked={selectedSourceFileIds.has(file.id)}
                  disabled={!isSourceFileTaskDeletionSelectable(file)}
                  onCheckedChange={(checked) => onToggleSourceFileSelection(file.id, checked === true)}
                />
              </TableCell>
              <TableCell>{formatFileStatus(file, t)}</TableCell>
              <TableCell>
                <span className="block max-w-72 truncate">
                  {file.relativePath}
                </span>
              </TableCell>
              <TableCell>
                <span className="block max-w-48 truncate text-muted-foreground">{file.id}</span>
              </TableCell>
              <TableCell>{formatFileStage(file, t)}</TableCell>
              <TableCell className="text-muted-foreground">
                {formatModelInvocation(file, t)}
              </TableCell>
              <TableCell>
                {formatGeneratedFileStatus(file, t)}
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
                {file.generatedFileAvailable && onOpenGeneratedFile ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onOpenGeneratedFile(file)}
                  >
                    {t("tasks.openGeneratedFile")}
                  </Button>
                ) : file.processingStatus === "failed" && onRetrySourceFile ? (
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

function formatGeneratedFileStatus(
  file: SourceFileRecord,
  t: ReturnType<typeof useTranslation>["t"]
) {
  if (file.generatedFileAvailable || file.generatedOutputStatus === "visible") {
    return <span className="text-foreground">{t("tasks.generatedFile.available")}</span>;
  }

  if (file.generatedOutputStatus === "unavailable") {
    return <span className="text-destructive">{t("tasks.generatedFile.unavailable")}</span>;
  }

  return <span className="text-muted-foreground">{t("tasks.generatedFile.pending")}</span>;
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
