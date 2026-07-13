import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import type { BundleFileDetail, KnowledgeBasePublicUrls } from "@/lib/admin-api";

export function FilePreviewPanel({
  copiedUrl,
  previewHtml,
  publicUrls,
  relationships = [],
  selectedFileTitle,
  selectedFilePath,
  onCopy,
  onOpenPreviewPath
}: {
  copiedUrl: string;
  previewHtml: string;
  publicUrls: KnowledgeBasePublicUrls | null;
  relationships?: BundleFileDetail["relationships"];
  selectedFileTitle: string;
  selectedFilePath: string;
  onCopy: (url: string) => void;
  onOpenPreviewPath: (path: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const selectedPublicUrl =
    publicUrls && selectedFilePath ? buildSelectedFilePublicUrl(publicUrls.index, selectedFilePath) : null;
  const copyUrl = selectedPublicUrl ?? publicUrls?.index ?? null;

  function handlePreviewClick(event: MouseEvent<HTMLElement>) {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    const control = target.closest<HTMLButtonElement>("button[data-preview-path]");
    const previewPath = control?.dataset.previewPath;
    const previewTitle = control?.textContent?.trim();

    if (!previewPath) {
      return;
    }

    event.preventDefault();
    onOpenPreviewPath(previewPath, previewTitle || previewPath);
  }

  return (
    <Card className="min-h-[calc(100svh-5.5rem)] min-w-0">
      <CardHeader>
        <CardTitle>{selectedFileTitle || selectedFilePath || t("detail.noFileSelected")}</CardTitle>
        <CardDescription>{t("result.preview")}</CardDescription>
        {copyUrl ? (
          <CardAction>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t(selectedFilePath ? "result.copyFile" : "result.copyIndex")}
              onClick={() => onCopy(copyUrl)}
            >
              <CopyIcon />
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {copiedUrl ? <p className="mb-3 text-sm text-muted-foreground">{t("result.copied")}</p> : null}
        {previewHtml ? (
          <article
            className="prose prose-sm max-w-none text-foreground"
            onClick={handlePreviewClick}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : (
          <div className="flex min-h-80 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            {t("detail.noFileSelected")}
          </div>
        )}
        {relationships.length > 0 ? (
          <section className="mt-6 border-t pt-4">
            <div className="mb-3">
              <h3 className="text-sm font-medium">{t("detail.relatedFiles")}</h3>
              <p className="text-xs text-muted-foreground">{t("detail.relatedFilesDescription")}</p>
            </div>
            <div className="space-y-2">
              {relationships.map((relationship) => (
                <div
                  key={`${relationship.fileId}:${relationship.direction}:${relationship.relationType}`}
                  className="rounded-md border p-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{relationship.title || relationship.path}</p>
                      <p className="truncate text-xs text-muted-foreground">{relationship.path}</p>
                    </div>
                    {relationship.contentAvailable ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenPreviewPath(relationship.path, relationship.title || relationship.path)}
                      >
                        {t("detail.openRelatedFile")}
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>{t("detail.relationshipType", { type: relationship.relationType })}</span>
                    <span>{t("detail.relationshipDirection", { direction: relationship.direction })}</span>
                    <span>{t("detail.relationshipWeight", { weight: relationship.weight.toFixed(2) })}</span>
                  </div>
                  {relationship.reason ? (
                    <p className="mt-2 text-xs text-muted-foreground">{relationship.reason}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

function buildSelectedFilePublicUrl(indexUrl: string, logicalPath: string): string {
  const url = new URL(indexUrl);
  url.searchParams.set("path", logicalPath);
  return url.toString();
}
