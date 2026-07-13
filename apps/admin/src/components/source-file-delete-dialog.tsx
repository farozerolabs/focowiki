import { useTranslation } from "react-i18next";
import type { AdminSidebarTreeNode } from "@/components/app-sidebar";
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
import { Alert, AlertTitle } from "@/components/ui/alert";

export function SourceFileDeleteDialog(props: {
  target: AdminSidebarTreeNode | null;
  busy: boolean;
  errorMessageKey: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={Boolean(props.target)} onOpenChange={(open) => !open && !props.busy && props.onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("delete.fileTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("delete.fileDescription", { name: props.target?.name ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {props.errorMessageKey ? (
          <Alert variant="destructive"><AlertTitle>{t(props.errorMessageKey)}</AlertTitle></Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.busy}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={props.busy}
            onClick={(event) => {
              event.preventDefault();
              props.onConfirm();
            }}
          >
            {props.busy ? t("delete.deleting") : t("delete.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
