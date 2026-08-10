import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCwIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { showAdminToast } from "@/hooks/use-admin-toast";
import {
  cancelKnowledgeBaseIndexMaintenance,
  requestKnowledgeBaseIndexMaintenance,
  type ProcessingSummary
} from "@/lib/admin-api";

export function KnowledgeBaseMaintenancePanel({
  knowledgeBaseId,
  summary,
  onRefresh
}: {
  knowledgeBaseId: string;
  summary: ProcessingSummary | null;
  onRefresh: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [confirmationAction, setConfirmationAction] = useState<"start" | "cancel">("start");
  const [submitting, setSubmitting] = useState(false);
  const maintenance = summary?.indexMaintenance ?? null;
  const active = maintenance?.active ?? false;
  const completed = maintenance?.completedCount ?? 0;
  const expected = maintenance?.expectedCount ?? 0;

  async function submit() {
    setSubmitting(true);
    const result = await requestKnowledgeBaseIndexMaintenance({
      knowledgeBaseId,
      idempotencyKey: crypto.randomUUID()
    });
    setSubmitting(false);
    setConfirmationOpen(false);

    if ("messageKey" in result) {
      showAdminToast({
        title: t("indexMaintenance.toast.failed"),
        description: t(result.messageKey),
        variant: "destructive"
      });
      await onRefresh();
      return;
    }
    showAdminToast({
      title: result.result === "already_active"
        ? t("indexMaintenance.toast.alreadyActive")
        : t("indexMaintenance.toast.accepted")
    });
    await onRefresh();
  }

  async function cancel() {
    setSubmitting(true);
    const result = await cancelKnowledgeBaseIndexMaintenance({ knowledgeBaseId });
    setSubmitting(false);
    setConfirmationOpen(false);
    if ("messageKey" in result) {
      showAdminToast({
        title: t("indexMaintenance.toast.cancelFailed"),
        description: t(result.messageKey),
        variant: "destructive"
      });
    } else {
      showAdminToast({
        title: result.result === "cancelled"
          ? t("indexMaintenance.toast.cancelled")
          : t("indexMaintenance.toast.notActive")
      });
    }
    await onRefresh();
  }

  return (
    <>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 pb-8">
          <header className="flex flex-col gap-1">
            <h1 className="text-base font-semibold">{t("indexMaintenance.title")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("indexMaintenance.description")}
            </p>
          </header>
          <Card className="gap-0 rounded-lg py-0">
            <CardContent className="p-0">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t("indexMaintenance.cardTitle")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("indexMaintenance.cardDescription")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={submitting || !summary}
                  onClick={() => {
                    setConfirmationAction(active ? "cancel" : "start");
                    setConfirmationOpen(true);
                  }}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  {active ? t("indexMaintenance.cancelAction") : t("indexMaintenance.action")}
                </Button>
              </div>
              <Separator />
              <StatusRow
                label={t("indexMaintenance.requirement")}
                value={maintenance
                  ? t(
                      maintenance.maintenanceRequired
                        ? "indexMaintenance.required"
                        : "indexMaintenance.upToDate"
                    )
                  : t("indexMaintenance.preparing")}
              />
              <Separator />
              <StatusRow
                label={t("indexMaintenance.status")}
                value={t(`indexMaintenance.states.${maintenance?.state ?? "idle"}`)}
              />
              {active ? (
                <>
                  <Separator />
                  <StatusRow
                    label={t("indexMaintenance.stage")}
                    value={maintenance?.stage
                      ? maintenanceStageLabel(maintenance.stage, t)
                      : t("indexMaintenance.preparing")}
                  />
                  <Separator />
                  <StatusRow
                    label={t("indexMaintenance.progress")}
                    value={expected > 0
                      ? t("indexMaintenance.progressValue", { completed, expected })
                      : t("indexMaintenance.preparing")}
                  />
                </>
              ) : null}
              <Separator />
              <StatusRow
                label={t("indexMaintenance.lastCompleted")}
                value={maintenance?.lastCompletedAt
                  ? new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: "medium",
                      timeStyle: "medium"
                    }).format(new Date(maintenance.lastCompletedAt))
                  : t("indexMaintenance.neverCompleted")}
              />
              {maintenance?.state === "failed" && maintenance.safeErrorMessage ? (
                <>
                  <Separator />
                  <StatusRow
                    label={t("indexMaintenance.failure")}
                    value={maintenanceFailureLabel(
                      maintenance.safeErrorCode,
                      maintenance.safeErrorMessage,
                      t
                    )}
                  />
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
      <AlertDialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(
              confirmationAction === "cancel"
                ? "indexMaintenance.cancelConfirmTitle"
                : "indexMaintenance.confirmTitle"
            )}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                confirmationAction === "cancel"
                  ? "indexMaintenance.cancelConfirmDescription"
                  : "indexMaintenance.confirmDescription"
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={() => void (confirmationAction === "cancel" ? cancel() : submit())}
            >
              {submitting
                ? t(confirmationAction === "cancel"
                    ? "indexMaintenance.cancelling"
                    : "indexMaintenance.submitting")
                : t(confirmationAction === "cancel"
                    ? "indexMaintenance.cancelConfirmAction"
                    : "indexMaintenance.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-2.5 pr-4 pl-8">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="max-w-md break-words text-right text-sm text-muted-foreground">
        {value}
      </span>
    </div>
  );
}

function maintenanceStageLabel(
  stage: string,
  translate: (key: string) => string
): string {
  if (stage.startsWith("projection:")) return translate("indexMaintenance.stages.projection");
  if (stage.startsWith("search:")) return translate("indexMaintenance.stages.search");
  if (stage === "compaction") return translate("indexMaintenance.stages.compaction");
  if (stage === "validating") return translate("indexMaintenance.stages.validating");
  if (stage === "retrying") return translate("indexMaintenance.stages.retrying");
  if (stage === "search_rebuild") return translate("indexMaintenance.stages.search");
  if (stage === "projection_repair" || stage === "object_reconciliation") {
    return translate("indexMaintenance.stages.projection");
  }
  if (stage === "catch_up") return translate("indexMaintenance.stages.catchUp");
  if (stage === "validation") return translate("indexMaintenance.stages.validating");
  if (stage === "activation") return translate("indexMaintenance.stages.activating");
  if (stage === "cleanup") return translate("indexMaintenance.stages.cleanup");
  return translate("indexMaintenance.stages.preparing");
}

function maintenanceFailureLabel(
  code: string | null,
  fallback: string,
  translate: (key: string) => string
): string {
  if (code === "INDEX_MAINTENANCE_STATISTICS_FAILED") {
    return translate("indexMaintenance.failures.statistics");
  }
  if (code === "INDEX_MAINTENANCE_COMPACTION_FAILED") {
    return translate("indexMaintenance.failures.compaction");
  }
  if (code === "INDEX_MAINTENANCE_FAILED") {
    return translate("indexMaintenance.failures.general");
  }
  return fallback;
}
