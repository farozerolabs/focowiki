import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef
} from "@tanstack/react-table";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { formatDisplayFileName } from "@/lib/display-file-name";
import type { UploadTaskDetail, UploadTaskLifecycle } from "@/lib/admin-api";

type UploadTaskDataTableProps = {
  tasks: UploadTaskLifecycle[];
  taskDetailsById: Record<string, UploadTaskDetail | null>;
};

type UploadTaskTableRow = {
  id: string;
  taskId: string;
  lifecycle: UploadTaskLifecycle["lifecycle"];
  fileNames: string;
  detail: string;
  startedAt: string | null;
  endedAt: string | null;
};

export function UploadTaskDataTable({ tasks, taskDetailsById }: UploadTaskDataTableProps) {
  const { i18n, t } = useTranslation();
  const rows = useMemo(
    () => buildTaskRows(tasks, taskDetailsById, t),
    [taskDetailsById, tasks, t]
  );

  const columns = useMemo<ColumnDef<UploadTaskTableRow>[]>(
    () => [
      {
        accessorKey: "lifecycle",
        header: () => t("tasks.table.status"),
        cell: ({ row }) => (
          <span className="font-medium">
            {row.original.lifecycle === "ended" ? t("tasks.ended") : t("tasks.running")}
          </span>
        )
      },
      {
        accessorKey: "fileNames",
        header: () => t("tasks.table.fileName"),
        cell: ({ row }) => <span className="block max-w-64 truncate">{row.original.fileNames}</span>
      },
      {
        accessorKey: "taskId",
        header: () => t("tasks.table.taskId"),
        cell: ({ row }) => (
          <span className="block max-w-56 truncate text-muted-foreground">{row.original.taskId}</span>
        )
      },
      {
        accessorKey: "detail",
        header: () => t("tasks.table.detail"),
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.detail}</span>
      },
      {
        accessorKey: "startedAt",
        header: () => t("tasks.table.startedAt"),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatTaskTime(row.original.startedAt, i18n.language, t("tasks.notRecorded"))}
          </span>
        )
      },
      {
        accessorKey: "endedAt",
        header: () => t("tasks.table.endedAt"),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatTaskTime(row.original.endedAt, i18n.language, t("tasks.notRecorded"))}
          </span>
        )
      }
    ],
    [i18n.language, t]
  );

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  if (tasks.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t("tasks.empty")}</p>;
  }

  return (
    <div className="overflow-hidden rounded-md border">
      <Table className="min-w-[64rem]">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function buildTaskRows(
  tasks: UploadTaskLifecycle[],
  taskDetailsById: Record<string, UploadTaskDetail | null>,
  t: ReturnType<typeof useTranslation>["t"]
): UploadTaskTableRow[] {
  return tasks.map((task) => {
    const phases = taskDetailsById[task.id]?.phaseDetails.items ?? [];
    const fileNames = formatFileNames(task, taskDetailsById[task.id], t);

    return {
      id: task.id,
      taskId: task.id,
      lifecycle: task.lifecycle,
      fileNames,
      detail: formatPhaseSummary(phases, t),
      startedAt: task.startedAt,
      endedAt: task.endedAt
    };
  });
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

function formatFileNames(
  task: UploadTaskLifecycle,
  detail: UploadTaskDetail | null | undefined,
  t: ReturnType<typeof useTranslation>["t"]
) {
  const names = detail?.sourceFiles?.items.map((file) => formatDisplayFileName(file.originalName)) ?? [];
  const hiddenCount = Math.max((task.sourceCount ?? names.length) - names.length, 0);

  if (names.length === 0) {
    return t("tasks.notRecorded");
  }

  return hiddenCount > 0
    ? `${names.join(", ")} ${t("tasks.moreFiles", { count: hiddenCount })}`
    : names.join(", ");
}

function formatTaskTime(value: string | null, locale: string, fallback: string) {
  if (!value) {
    return fallback;
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(value));
}
