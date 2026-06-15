import { useTranslation } from "react-i18next";
import { UploadIcon } from "lucide-react";
import { UploadTaskDataTable } from "@/components/task-phase-data-table";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import type { UploadTaskDetail, UploadTaskLifecycle } from "@/lib/admin-api";

type TaskProgressPanelProps = {
  tasks: UploadTaskLifecycle[];
  taskCursor: string | null;
  taskDetailsById: Record<string, UploadTaskDetail | null>;
  onLoadMore: () => void;
  onLoadMoreTaskSourceFiles: (taskId: string) => void;
  onUpload: () => void;
};

export function TaskProgressPanel({
  tasks,
  taskCursor,
  taskDetailsById,
  onLoadMore,
  onLoadMoreTaskSourceFiles,
  onUpload
}: TaskProgressPanelProps) {
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
          <UploadTaskDataTable
            tasks={tasks}
            taskDetailsById={taskDetailsById}
            onLoadMoreSourceFiles={onLoadMoreTaskSourceFiles}
          />
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
