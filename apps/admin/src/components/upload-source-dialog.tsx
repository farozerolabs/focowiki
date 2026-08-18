import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { UploadIcon, XIcon } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  cancelFolderUpload,
  runUploadSession,
  type UploadClientProgress
} from "@/lib/upload-session-client";
import {
  fileRelativePath,
  filesFromSelection,
  formatUploadBytes,
  hasDuplicateFileName,
  hasUnsupportedMarkdownFile,
  invalidSelectedUploadPaths,
  removeSelectedFileAt,
  totalSelectedFileBytes,
  visibleSelectedFiles
} from "@/lib/upload-selection";
import { selectDirectoryFiles } from "@/lib/directory-picker";

type UploadSourceDialogProps = {
  knowledgeBaseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccepted: () => Promise<void>;
};

export function UploadSourceDialog({
  knowledgeBaseId,
  open,
  onOpenChange,
  onAccepted
}: UploadSourceDialogProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadOperationEpochRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isSelectingFolder, setIsSelectingFolder] = useState(false);
  const [progress, setProgress] = useState<UploadClientProgress | null>(null);
  const selectedFileItems = visibleSelectedFiles(selectedFiles);
  const selectedFileTotalSize = formatUploadBytes(totalSelectedFileBytes(selectedFiles));
  const invalidPaths = invalidSelectedUploadPaths(selectedFiles);
  const uploadSelectionErrorKey = hasUnsupportedMarkdownFile(selectedFiles) || invalidPaths.length > 0
    ? hasUnsupportedMarkdownFile(selectedFiles)
      ? "errors.uploadMarkdownOnly"
      : "errors.uploadInvalidPath"
    : hasDuplicateFileName(selectedFiles)
      ? "errors.duplicateUploadFileName"
      : "";

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const operationEpoch = uploadOperationEpochRef.current + 1;
    uploadOperationEpochRef.current = operationEpoch;
    setIsUploading(true);
    setUploadError("");

    if (selectedFiles.length === 0) {
      setIsUploading(false);
      return;
    }

    if (uploadSelectionErrorKey) {
      setIsUploading(false);
      setUploadError(uploadSelectionErrorKey);
      return;
    }

    const uploadAbortController = new AbortController();
    uploadAbortControllerRef.current = uploadAbortController;

    const result = await runUploadSession({
      knowledgeBaseId,
      files: selectedFiles,
      signal: uploadAbortController.signal,
      onProgress: setProgress,
      onSessionReady: (id) => {
        if (uploadOperationEpochRef.current === operationEpoch) {
          activeSessionIdRef.current = id;
        }
      }
    }).catch(() => ({
      ok: false as const,
      failure: { messageKey: "errors.uploadFailed" },
      sessionId: null
    }));

    if (uploadOperationEpochRef.current !== operationEpoch) {
      return;
    }
    uploadAbortControllerRef.current = null;

    if (!result.ok) {
      if (result.sessionId) {
        activeSessionIdRef.current = result.sessionId;
        setIsUploading(true);
      } else {
        setIsUploading(false);
        activeSessionIdRef.current = null;
        if (result.failure.messageKey === "errors.uploadCancelled") {
          resetSelection();
        }
      }
      setUploadError(result.failure.messageKey);
      return;
    }

    resetSelection();
    onOpenChange(false);
    setIsUploading(false);
    await onAccepted();
  }

  function handleSourceFilesChange(files: FileList | null) {
    setSelectedFiles((current) => [...current, ...filesFromSelection(files)]);
    setUploadError("");
    resetInputs();
  }

  async function handleFolderSelection() {
    setIsSelectingFolder(true);
    setUploadError("");
    try {
      const result = await selectDirectoryFiles();
      if (result.status === "selected") {
        setSelectedFiles((current) => [...current, ...result.files]);
      } else if (result.status === "unsupported") {
        setUploadError("errors.folderPickerUnsupported");
      }
    } catch {
      setUploadError("errors.folderPickerFailed");
    } finally {
      setIsSelectingFolder(false);
    }
  }

  function handleRemoveSelectedFile(index: number) {
    setSelectedFiles((current) => removeSelectedFileAt(current, index));
    setUploadError("");
  }

  function resetSelection() {
    setSelectedFiles([]);
    setUploadError("");
    setProgress(null);
    activeSessionIdRef.current = null;
    resetInputs();
  }

  function resetInputs() {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleCancelUpload() {
    if (uploadAbortControllerRef.current) {
      uploadAbortControllerRef.current.abort();
      return;
    }
    const sessionId = activeSessionIdRef.current;
    if (sessionId) {
      const failure = await cancelFolderUpload({ knowledgeBaseId, sessionId })
        .catch(() => ({ messageKey: "errors.uploadCleanupFailed" }));
      if (failure) {
        setUploadError("errors.uploadCleanupFailed");
        return;
      }
    }
    uploadOperationEpochRef.current += 1;
    setIsUploading(false);
    resetSelection();
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !isUploading && onOpenChange(nextOpen)}>
      <DialogContent
        onPointerDownOutside={(event) => {
          if (isUploading) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("upload.title")}</DialogTitle>
          <DialogDescription>{t("upload.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleUpload}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="source-files">{t("upload.selectFiles")}</FieldLabel>
              <Button
                type="button"
                variant="outline"
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadIcon data-icon="inline-start" />
                {t("upload.chooseFiles")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={isSelectingFolder || isUploading}
                onClick={() => void handleFolderSelection()}
              >
                <UploadIcon data-icon="inline-start" />
                {t("upload.chooseFolder")}
              </Button>
              <input
                ref={fileInputRef}
                id="source-files"
                type="file"
                accept=".md"
                multiple
                className="sr-only"
                aria-describedby="source-files-status"
                onChange={(event) => handleSourceFilesChange(event.target.files)}
              />
              <div
                id="source-files-status"
                className="rounded-lg border bg-muted/40 p-2 text-sm text-muted-foreground"
              >
                {selectedFiles.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <p>
                        {t(selectedFiles.length === 1 ? "upload.selectedFile" : "upload.selectedFiles", {
                          count: selectedFiles.length
                        })}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isUploading}
                        onClick={resetSelection}
                      >
                        {t("upload.clearSelection")}
                      </Button>
                    </div>
                    <p>{t("upload.totalSize", { size: selectedFileTotalSize })}</p>
                    <ul className="flex flex-col gap-1">
                      {selectedFileItems.items.map((file, index) => (
                        <li
                          key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                          className="flex items-center justify-between gap-2 text-foreground"
                        >
                          <span className="min-w-0 truncate">{fileRelativePath(file)}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            disabled={isUploading}
                            aria-label={t("upload.removeFile", { name: file.name })}
                            onClick={() => handleRemoveSelectedFile(index)}
                          >
                            <XIcon />
                          </Button>
                        </li>
                      ))}
                    </ul>
                    {selectedFileItems.hiddenCount > 0 ? (
                      <p>{t("upload.hiddenFiles", { count: selectedFileItems.hiddenCount })}</p>
                    ) : null}
                    <p>{t("upload.repeatedFolderMerge")}</p>
                  </div>
                ) : (
                  <p>{t("upload.noFilesSelected")}</p>
                )}
              </div>
              {uploadSelectionErrorKey ? (
                <div className="space-y-1 text-sm text-destructive">
                  <p>{t(uploadSelectionErrorKey)}</p>
                  {invalidPaths.slice(0, 8).map((path) => (
                    <p key={path} className="truncate">{path}</p>
                  ))}
                  {invalidPaths.length > 8 ? (
                    <p>{t("upload.hiddenInvalidFiles", { count: invalidPaths.length - 8 })}</p>
                  ) : null}
                </div>
              ) : null}
            </Field>
            {uploadError ? (
              <Alert variant="destructive">
                <AlertTitle>{t(uploadError)}</AlertTitle>
              </Alert>
            ) : null}
            {progress ? (
              <div className="space-y-2" aria-live="polite">
                <div className="h-2 overflow-hidden rounded-sm bg-muted">
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{
                      width: `${progress.total > 0 ? Math.min(100, (progress.completed / progress.total) * 100) : 0}%`
                    }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  {t(`upload.stages.${progress.stage}`, {
                    completed: progress.completed,
                    total: progress.total
                  })}
                </p>
                {progress.session ? (
                  <p className="text-sm text-muted-foreground">
                    {t("upload.classification", progress.session.counts)}
                  </p>
                ) : null}
              </div>
            ) : null}
            <Button
              type="submit"
              disabled={selectedFiles.length === 0 || Boolean(uploadSelectionErrorKey) || isUploading}
            >
              {isUploading
                ? t("upload.uploading")
                : t("upload.upload")}
            </Button>
            {isUploading ? (
              <Button type="button" variant="outline" onClick={handleCancelUpload}>
                {t("upload.cancel")}
              </Button>
            ) : null}
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
