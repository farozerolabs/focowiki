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
import { uploadKnowledgeBaseSources, type UploadTaskLifecycle } from "@/lib/admin-api";
import {
  filesFromSelection,
  formatUploadBytes,
  hasDuplicateFileName,
  hasUnsupportedMarkdownFile,
  removeSelectedFileAt,
  totalSelectedFileBytes,
  visibleSelectedFiles
} from "@/lib/upload-selection";

type UploadSourceDialogProps = {
  knowledgeBaseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccepted: (task: UploadTaskLifecycle) => Promise<void>;
};

export function UploadSourceDialog({
  knowledgeBaseId,
  open,
  onOpenChange,
  onAccepted
}: UploadSourceDialogProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const selectedFileItems = visibleSelectedFiles(selectedFiles);
  const selectedFileTotalSize = formatUploadBytes(totalSelectedFileBytes(selectedFiles));
  const uploadSelectionErrorKey = hasUnsupportedMarkdownFile(selectedFiles)
    ? "errors.uploadMarkdownOnly"
    : hasDuplicateFileName(selectedFiles)
      ? "errors.duplicateUploadFileName"
      : "";

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

    const result = await uploadKnowledgeBaseSources({
      knowledgeBaseId,
      files: selectedFiles
    }).catch(() => ({ messageKey: "errors.uploadFailed" }));

    if ("messageKey" in result) {
      setIsUploading(false);
      setUploadError(result.messageKey);
      return;
    }

    resetSelection();
    onOpenChange(false);
    setIsUploading(false);
    await onAccepted(result.task);
  }

  function handleSourceFilesChange(files: FileList | null) {
    setSelectedFiles(filesFromSelection(files));
    setUploadError("");
    resetSourceFileInput();
  }

  function handleRemoveSelectedFile(index: number) {
    setSelectedFiles((current) => removeSelectedFileAt(current, index));
    setUploadError("");
  }

  function resetSelection() {
    setSelectedFiles([]);
    setUploadError("");
    resetSourceFileInput();
  }

  function resetSourceFileInput() {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
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
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadIcon data-icon="inline-start" />
                {t("upload.chooseFiles")}
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
                      <Button type="button" variant="ghost" size="sm" onClick={resetSelection}>
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
                          <span className="min-w-0 truncate">{file.name}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
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
                  </div>
                ) : (
                  <p>{t("upload.noFilesSelected")}</p>
                )}
              </div>
              {uploadSelectionErrorKey ? (
                <p className="text-sm text-destructive">{t(uploadSelectionErrorKey)}</p>
              ) : null}
            </Field>
            {uploadError ? (
              <Alert variant="destructive">
                <AlertTitle>{t(uploadError)}</AlertTitle>
              </Alert>
            ) : null}
            <Button
              type="submit"
              disabled={selectedFiles.length === 0 || Boolean(uploadSelectionErrorKey) || isUploading}
            >
              {isUploading ? t("upload.uploading") : t("upload.upload")}
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
