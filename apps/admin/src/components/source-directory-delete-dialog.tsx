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

export function SourceDirectoryDeleteDialog(props: {
  target: AdminSidebarTreeNode | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={Boolean(props.target)} onOpenChange={(open) => !open && !props.busy && props.onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("delete.directoryTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("delete.directoryDescription", {
              name: props.target?.name ?? "",
              count: props.target?.descendantFileCount ?? 0
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
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
