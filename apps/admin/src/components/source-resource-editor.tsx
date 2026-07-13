import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ChevronLeftIcon, FolderIcon, UploadIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AdminSidebarTreeNode } from "@/components/app-sidebar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { showAdminToast } from "@/hooks/use-admin-toast";
import { fetchSourceFile } from "@/lib/admin-api";
import {
  fetchSourceDirectory,
  listSourceDirectories,
  moveSourceDirectory,
  moveSourceFile,
  readSourceFileContent,
  replaceSourceFileContent,
  type ResourceOperation,
  type SourceDirectory
} from "@/lib/resource-editing-api";

export type SourceResourceEditAction = "rename" | "move" | "replace";
export type SourceResourceEditRequest = {
  action: SourceResourceEditAction;
  node: AdminSidebarTreeNode;
};

type ResourceSnapshot = {
  id: string;
  kind: "file" | "directory";
  name: string;
  relativePath: string;
  resourceRevision: number;
};

export function SourceResourceEditor(props: {
  knowledgeBaseId: string;
  request: SourceResourceEditRequest | null;
  onClose: () => void;
  onAccepted: (operation: ResourceOperation) => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [value, setValue] = useState("");
  const [content, setContent] = useState("");
  const [errorKey, setErrorKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [directoryStack, setDirectoryStack] = useState<Array<{ id: string | null; path: string }>>([
    { id: null, path: "" }
  ]);
  const [directories, setDirectories] = useState<SourceDirectory[]>([]);
  const currentDestination = directoryStack.at(-1) ?? { id: null, path: "" };
  const isReplacement = props.request?.action === "replace";

  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setValue("");
    setContent("");
    setErrorKey("");
    setDirectoryStack([{ id: null, path: "" }]);
    if (!props.request) return () => { active = false; };

    void (async () => {
      const node = props.request?.node;
      if (!node) return;
      if (node.entryType === "file" && node.sourceFileId) {
        const file = await fetchSourceFile({
          knowledgeBaseId: props.knowledgeBaseId,
          sourceFileId: node.sourceFileId
        });
        if (!active || !file?.resourceRevision) return;
        const next: ResourceSnapshot = {
          id: file.id,
          kind: "file",
          name: file.name,
          relativePath: file.relativePath,
          resourceRevision: file.resourceRevision
        };
        setSnapshot(next);
        setValue(file.name);
        if (props.request?.action === "replace") {
          const result = await readSourceFileContent({
            knowledgeBaseId: props.knowledgeBaseId,
            sourceFileId: file.id
          });
          if (!active) return;
          if ("messageKey" in result) setErrorKey(result.messageKey);
          else setContent(result.content);
        }
        return;
      }
      if (node.entryType === "directory" && node.sourceDirectoryId) {
        const result = await fetchSourceDirectory({
          knowledgeBaseId: props.knowledgeBaseId,
          sourceDirectoryId: node.sourceDirectoryId
        });
        if (!active) return;
        if ("messageKey" in result) {
          setErrorKey(result.messageKey);
          return;
        }
        setSnapshot({
          id: result.directory.directoryId,
          kind: "directory",
          name: result.directory.name,
          relativePath: result.directory.relativePath,
          resourceRevision: result.directory.resourceRevision
        });
        setValue(result.directory.name);
      }
    })();
    return () => { active = false; };
  }, [props.knowledgeBaseId, props.request]);

  useEffect(() => {
    if (props.request?.action !== "move") return;
    let active = true;
    void listSourceDirectories({
      knowledgeBaseId: props.knowledgeBaseId,
      parentDirectoryId: currentDestination.id
    }).then((result) => {
      if (!active) return;
      setDirectories("messageKey" in result ? [] : result.items);
    });
    return () => { active = false; };
  }, [currentDestination.id, props.knowledgeBaseId, props.request?.action]);

  const targetPath = useMemo(() => {
    if (!snapshot) return "";
    if (props.request?.action === "move") return joinPath(currentDestination.path, snapshot.name);
    return joinPath(parentPath(snapshot.relativePath), value.trim());
  }, [currentDestination.path, props.request?.action, snapshot, value]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!snapshot) return;
    if (snapshot.kind === "file" && props.request?.action === "rename" && !value.trim().endsWith(".md")) {
      setErrorKey("resourceEditing.markdownNameRequired");
      return;
    }
    setBusy(true);
    setErrorKey("");
    const result = props.request?.action === "replace"
      ? await replaceSourceFileContent({
          knowledgeBaseId: props.knowledgeBaseId,
          sourceFileId: snapshot.id,
          resourceRevision: snapshot.resourceRevision,
          content
        })
      : snapshot.kind === "file"
        ? await moveSourceFile({
            knowledgeBaseId: props.knowledgeBaseId,
            sourceFileId: snapshot.id,
            resourceRevision: snapshot.resourceRevision,
            relativePath: targetPath
          })
        : await moveSourceDirectory({
            knowledgeBaseId: props.knowledgeBaseId,
            sourceDirectoryId: snapshot.id,
            resourceRevision: snapshot.resourceRevision,
            relativePath: targetPath
          });
    setBusy(false);
    if ("messageKey" in result) {
      setErrorKey(result.messageKey);
      showAdminToast({
        title: t("resourceEditing.failedTitle"),
        description: t(result.messageKey),
        variant: "destructive"
      });
      return;
    }
    props.onAccepted(result.operation);
    props.onClose();
  }

  const commonForm = (
    <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={submit}>
      {props.request?.action === "move" ? (
        <div className="min-h-0 space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("resourceEditing.destination")}: /{currentDestination.path}
          </p>
          {directoryStack.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDirectoryStack((current) => current.slice(0, -1))}
            >
              <ChevronLeftIcon data-icon="inline-start" />
              {t("resourceEditing.parentDirectory")}
            </Button>
          ) : null}
          <div className="max-h-64 space-y-1 overflow-auto rounded-md border p-1">
            {directories.map((directory) => {
              const disabled = snapshot?.kind === "directory" &&
                (directory.relativePath === snapshot.relativePath ||
                  directory.relativePath.startsWith(`${snapshot.relativePath}/`));
              return (
                <Button
                  key={directory.directoryId}
                  type="button"
                  variant="ghost"
                  className="w-full justify-start"
                  disabled={disabled}
                  onClick={() => setDirectoryStack((current) => [
                    ...current,
                    { id: directory.directoryId, path: directory.relativePath }
                  ])}
                >
                  <FolderIcon data-icon="inline-start" />
                  {directory.name}
                </Button>
              );
            })}
            {directories.length === 0 ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">
                {t("resourceEditing.noDirectories")}
              </p>
            ) : null}
          </div>
        </div>
      ) : props.request?.action === "rename" ? (
        <Field data-invalid={Boolean(errorKey)}>
          <FieldLabel htmlFor="source-resource-name">{t("resourceEditing.name")}</FieldLabel>
          <Input
            id="source-resource-name"
            value={value}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
      ) : (
        <Field data-invalid={Boolean(errorKey)} className="min-h-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor="source-resource-content">{t("resourceEditing.content")}</FieldLabel>
            <Button type="button" variant="outline" size="sm" asChild>
              <label>
                <UploadIcon data-icon="inline-start" />
                {t("resourceEditing.chooseMarkdown")}
                <input
                  type="file"
                  accept=".md,text/markdown"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void file.text().then(setContent);
                  }}
                />
              </label>
            </Button>
          </div>
          <Textarea
            id="source-resource-content"
            value={content}
            className="min-h-96 flex-1 resize-none font-mono"
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
      )}
      {errorKey ? <FieldError>{t(errorKey)}</FieldError> : null}
      {isReplacement ? (
        <SheetFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !snapshot || !content.trim()}>
            {busy ? t("common.saving") : t("resourceEditing.replace")}
          </Button>
        </SheetFooter>
      ) : (
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || !snapshot || !targetPath || targetPath === snapshot?.relativePath}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      )}
    </form>
  );

  if (isReplacement) {
    return (
      <Sheet open onOpenChange={(open) => !open && !busy && props.onClose()}>
        <SheetContent className="sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{t("resourceEditing.replaceTitle")}</SheetTitle>
            <SheetDescription>{snapshot?.relativePath ?? props.request?.node.name}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 px-4">{commonForm}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return props.request ? (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(props.request.action === "rename" ? "resourceEditing.renameTitle" : "resourceEditing.moveTitle")}
          </DialogTitle>
          <DialogDescription>{snapshot?.relativePath ?? props.request.node.name}</DialogDescription>
        </DialogHeader>
        {commonForm}
      </DialogContent>
    </Dialog>
  ) : null;
}

function parentPath(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}

function joinPath(parent: string, name: string): string {
  return [parent, name].filter(Boolean).join("/");
}
