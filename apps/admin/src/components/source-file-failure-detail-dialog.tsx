import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import type { SourceFileRecord } from "@/lib/admin-api";
import { formatSourceFileTime } from "./task-table-formatters";

type SourceFileFailureDetailDialogProps = {
  sourceFile: SourceFileRecord | null;
  onOpenChange: (open: boolean) => void;
};

export function SourceFileFailureDetailDialog({
  sourceFile,
  onOpenChange
}: SourceFileFailureDetailDialogProps) {
  const { i18n, t } = useTranslation();
  const failure = sourceFile?.failure ?? null;

  return (
    <Dialog open={Boolean(failure)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("tasks.failureDetails.title")}</DialogTitle>
          <DialogDescription>{sourceFile?.relativePath}</DialogDescription>
        </DialogHeader>
        {failure ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_1fr]">
            <FailureDetail label={t("tasks.failureDetails.stage")}>
              {t(`tasks.phase.${toCamelCase(failure.stage)}`)}
            </FailureDetail>
            <FailureDetail label={t("tasks.failureDetails.code")}>
              <span className="break-all font-mono text-xs">{failure.code}</span>
            </FailureDetail>
            <FailureDetail label={t("tasks.failureDetails.message")}>
              <span className="break-words">{failure.message}</span>
            </FailureDetail>
            <FailureDetail label={t("tasks.failureDetails.occurredAt")}>
              {formatSourceFileTime(failure.occurredAt, i18n.language, t("tasks.notRecorded"))}
            </FailureDetail>
            <FailureDetail label={t("tasks.failureDetails.retryKind")}>
              {t(`tasks.failureDetails.retryKinds.${failure.retryKind}`)}
            </FailureDetail>
            <FailureDetail label={t("tasks.failureDetails.correlationId")}>
              <span className="break-all font-mono text-xs">{failure.correlationId}</span>
            </FailureDetail>
          </dl>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("common.close")}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FailureDetail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}
