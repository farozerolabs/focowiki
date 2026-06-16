import { ChevronDownIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { Fragment } from "react";
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
import type { UploadTaskDetail, UploadTaskLifecycle } from "@/lib/admin-api";
import { TaskFileDataTable } from "./task-file-data-table";
import {
  formatTaskCurrentStage,
  formatTaskFileCount,
  formatTaskProgress,
  formatTaskTime
} from "./task-table-formatters";

type UploadTaskDataTableProps = {
  tasks: UploadTaskLifecycle[];
  taskDetailsById: Record<string, UploadTaskDetail | null>;
  expandedTaskIds: Set<string>;
  loadingTaskDetailIds: Set<string>;
  taskDetailErrorsById: Record<string, string | null>;
  onToggleTask: (taskId: string, open: boolean) => void;
  onLoadMoreSourceFiles?: (taskId: string) => void;
};

const TASK_TABLE_COLUMN_COUNT = 8;

export function UploadTaskDataTable({
  tasks,
  taskDetailsById,
  expandedTaskIds,
  loadingTaskDetailIds,
  taskDetailErrorsById,
  onToggleTask,
  onLoadMoreSourceFiles
}: UploadTaskDataTableProps) {
  const { i18n, t } = useTranslation();

  if (tasks.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t("tasks.empty")}</p>;
  }

  return (
    <div className="overflow-hidden rounded-md border">
      <Table className="min-w-[72rem]" aria-label={t("tasks.title")}>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">{t("tasks.table.expand")}</TableHead>
            <TableHead>{t("tasks.table.status")}</TableHead>
            <TableHead>{t("tasks.table.currentStage")}</TableHead>
            <TableHead>{t("tasks.table.files")}</TableHead>
            <TableHead>{t("tasks.table.progress")}</TableHead>
            <TableHead>{t("tasks.table.taskId")}</TableHead>
            <TableHead>{t("tasks.table.startedAt")}</TableHead>
            <TableHead>{t("tasks.table.endedAt")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => {
            const isExpanded = expandedTaskIds.has(task.id);
            const ExpandIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;

            return (
              <Fragment key={task.id}>
                <TableRow key={task.id} data-testid={`upload-task-row-${task.id}`}>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t(isExpanded ? "tasks.collapseTask" : "tasks.expandTask", {
                        id: task.id
                      })}
                      onClick={() => onToggleTask(task.id, !isExpanded)}
                    >
                      <ExpandIcon aria-hidden="true" />
                    </Button>
                  </TableCell>
                  <TableCell className="font-medium">
                    {task.lifecycle === "ended" ? t("tasks.ended") : t("tasks.running")}
                  </TableCell>
                  <TableCell>{formatTaskCurrentStage(task, t)}</TableCell>
                  <TableCell>{formatTaskFileCount(task, t)}</TableCell>
                  <TableCell>{formatTaskProgress(task, t)}</TableCell>
                  <TableCell>
                    <span className="block max-w-56 truncate text-muted-foreground">{task.id}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTaskTime(task.startedAt, i18n.language, t("tasks.notRecorded"))}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTaskTime(task.endedAt, i18n.language, t("tasks.notRecorded"))}
                  </TableCell>
                </TableRow>
                {isExpanded ? (
                  <TableRow key={`${task.id}-files`}>
                    <TableCell colSpan={TASK_TABLE_COLUMN_COUNT}>
                      <div className="flex flex-col gap-3">
                        <TaskFileDataTable
                          taskId={task.id}
                          detail={taskDetailsById[task.id]}
                          isLoading={loadingTaskDetailIds.has(task.id)}
                          error={taskDetailErrorsById[task.id]}
                          onLoadMore={() => onLoadMoreSourceFiles?.(task.id)}
                        />
                        <div className="flex justify-end">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void navigator.clipboard?.writeText(task.id)}
                          >
                            <CopyIcon data-icon="inline-start" />
                            {t("tasks.copyTaskId", { id: task.id })}
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
