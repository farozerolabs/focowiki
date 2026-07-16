import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { CopyIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import type {
  ApiFailure,
  OneTimePublicOpenApiKey,
  PublicOpenApiKey
} from "@/lib/admin-api";

type OpenApiKeysPanelProps = {
  keys: PublicOpenApiKey[];
  oneTimeKey: OneTimePublicOpenApiKey | null;
  nextCursor: string | null;
  isLoading: boolean;
  onCreate: (
    input: { name: string }
  ) => Promise<{ key: PublicOpenApiKey; oneTimeKey: OneTimePublicOpenApiKey } | ApiFailure>;
  onDelete: (key: PublicOpenApiKey) => Promise<{ deleted: true } | ApiFailure>;
  onDismissOneTimeKey: () => void;
  onLoadMore: () => void;
};

export function OpenApiKeysPanel({
  keys,
  oneTimeKey,
  nextCursor,
  isLoading,
  onCreate,
  onDelete,
  onDismissOneTimeKey,
  onLoadMore
}: OpenApiKeysPanelProps) {
  const { t } = useTranslation();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PublicOpenApiKey | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  useEffect(() => {
    setCopiedKeyId(null);
  }, [oneTimeKey?.id]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError("");
    setIsCreating(true);
    const result = await onCreate({ name });
    setIsCreating(false);

    if ("messageKey" in result) {
      setCreateError(result.messageKey);
      return;
    }

    setName("");
    setIsCreateOpen(false);
  }

  async function handleDelete() {
    if (!deleteTarget) {
      return;
    }

    setDeleteError("");
    setIsDeleting(true);
    const result = await onDelete(deleteTarget);
    setIsDeleting(false);

    if ("messageKey" in result) {
      setDeleteError(result.messageKey);
      return;
    }

    setDeleteTarget(null);
  }

  async function copyOneTimeKey() {
    if (!oneTimeKey) {
      return;
    }

    await navigator.clipboard?.writeText(oneTimeKey.rawKey);
    setCopiedKeyId(oneTimeKey.id);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div />
        <Button type="button" onClick={() => setIsCreateOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          {t("openapiKeys.createAction")}
        </Button>
      </div>

      {isLoading && keys.length === 0 ? (
        <Alert>
          <AlertTitle>{t("home.loading")}</AlertTitle>
        </Alert>
      ) : null}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("openapiKeys.table.name")}</TableHead>
              <TableHead>{t("openapiKeys.table.fingerprint")}</TableHead>
              <TableHead>{t("openapiKeys.table.status")}</TableHead>
              <TableHead>{t("openapiKeys.table.createdAt")}</TableHead>
              <TableHead>{t("openapiKeys.table.lastUsedAt")}</TableHead>
              <TableHead className="text-right">{t("openapiKeys.table.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 && !isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  {t("openapiKeys.empty")}
                </TableCell>
              </TableRow>
            ) : null}
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell>{key.name}</TableCell>
                <TableCell>{key.fingerprint}</TableCell>
                <TableCell>{t(`openapiKeys.status.${key.status}`)}</TableCell>
                <TableCell>{formatDateTime(key.createdAt)}</TableCell>
                <TableCell>
                  {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : t("openapiKeys.neverUsed")}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("openapiKeys.deleteAction", { name: key.name })}
                    disabled={key.status !== "active"}
                    onClick={() => {
                      setDeleteError("");
                      setDeleteTarget(key);
                    }}
                  >
                    <Trash2Icon />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {nextCursor ? (
        <Button type="button" variant="outline" onClick={onLoadMore} disabled={isLoading}>
          {isLoading ? t("home.loading") : t("home.loadMore")}
        </Button>
      ) : null}

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("openapiKeys.createAction")}</DialogTitle>
            <DialogDescription>{t("openapiKeys.createDescription")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <FieldGroup>
              <Field data-invalid={Boolean(createError)}>
                <FieldLabel htmlFor="openapi-key-name">{t("openapiKeys.nameLabel")}</FieldLabel>
                <Input
                  id="openapi-key-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              {createError ? <FieldError>{t(createError)}</FieldError> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={isCreating}>
                  {isCreating ? t("openapiKeys.creating") : t("openapiKeys.createSubmit")}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(oneTimeKey)}
        onOpenChange={(open) => {
          if (!open) {
            onDismissOneTimeKey();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("openapiKeys.oneTimeTitle")}</DialogTitle>
            <DialogDescription>{t("openapiKeys.oneTimeDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="openapi-one-time-key">{t("openapiKeys.oneTimeLabel")}</FieldLabel>
              <Input
                id="openapi-one-time-key"
                readOnly
                value={oneTimeKey?.rawKey ?? ""}
                aria-label={t("openapiKeys.oneTimeLabel")}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onDismissOneTimeKey}>
                {t("common.close")}
              </Button>
              <Button type="button" onClick={() => void copyOneTimeKey()} disabled={!oneTimeKey}>
                <CopyIcon data-icon="inline-start" />
                {copiedKeyId === oneTimeKey?.id ? t("common.copied") : t("common.copy")}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && !isDeleting && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("openapiKeys.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("openapiKeys.deleteDescription", { name: deleteTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <Alert variant="destructive">
              <AlertTitle>{t(deleteError)}</AlertTitle>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {isDeleting ? t("delete.deleting") : t("delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}
