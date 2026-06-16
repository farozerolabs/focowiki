import type { TFunction } from "i18next";
import type { UploadTaskLifecycle } from "@/lib/admin-api";

export function formatTaskTime(value: string | null | undefined, locale: string, fallback: string) {
  if (!value) {
    return fallback;
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(value));
}

export function formatTaskFileCount(task: UploadTaskLifecycle, t: TFunction) {
  const count = task.sourceCount ?? task.progress?.total ?? 0;

  return t(count === 1 ? "tasks.fileCount" : "tasks.fileCount_plural", {
    count
  });
}

export function formatTaskProgress(task: UploadTaskLifecycle, t: TFunction) {
  const progress = task.progress ?? {
    total: task.sourceCount ?? 0,
    completed: task.lifecycle === "ended" ? task.sourceCount ?? 0 : 0,
    failed: 0,
    running: task.lifecycle === "running" ? Math.min(task.sourceCount ?? 0, 1) : 0,
    pending:
      task.lifecycle === "running" ? Math.max((task.sourceCount ?? 0) - 1, 0) : 0
  };
  const parts = [
    t("tasks.progress", {
      completed: progress.completed,
      total: progress.total
    })
  ];

  if (progress.running > 0) {
    parts.push(t("tasks.runningFileProgress", { running: progress.running }));
  }
  if (progress.pending > 0) {
    parts.push(t("tasks.pendingFileProgress", { pending: progress.pending }));
  }
  if (progress.failed > 0) {
    parts.push(t("tasks.failedFileProgress", { failed: progress.failed }));
  }

  return parts.join(" | ");
}
