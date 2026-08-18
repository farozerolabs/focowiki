import { useCallback, useEffect, useState } from "react";
import {
  fetchKnowledgeBaseFileDetail,
  fetchKnowledgeBasePublicUrls,
  type GeneratedFileDetail,
  type KnowledgeBasePublicUrls
} from "@/lib/admin-api";
import { renderGeneratedTextPreview, renderMarkdownPreview } from "@/lib/markdown-preview";

export function useGeneratedFilePreview(knowledgeBaseId: string) {
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedFileTitle, setSelectedFileTitle] = useState("");
  const [selectedSourceFileId, setSelectedSourceFileId] = useState<string | null>(null);
  const [relationships, setRelationships] = useState<GeneratedFileDetail["relationships"]>([]);
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [publicUrls, setPublicUrls] = useState<KnowledgeBasePublicUrls | null>(null);
  const [publicUrlsError, setPublicUrlsError] = useState("");
  const [copiedUrl, setCopiedUrl] = useState("");

  const clearSelectedFile = useCallback(() => {
    setSelectedFilePath("");
    setSelectedFileTitle("");
    setRelationships([]);
    setSelectedSourceFileId(null);
    setPreviewHtml("");
    setPreviewError("");
  }, []);

  const loadPublicUrls = useCallback(async () => {
    try {
      setPublicUrls(await fetchKnowledgeBasePublicUrls({ knowledgeBaseId }));
      setPublicUrlsError("");
    } catch (error) {
      setPublicUrls(null);
      setPublicUrlsError(readErrorMessageKey(error));
    }
  }, [knowledgeBaseId]);

  useEffect(() => {
    clearSelectedFile();
    setPublicUrls(null);
    setPublicUrlsError("");
    setCopiedUrl("");
    void loadPublicUrls();
  }, [clearSelectedFile, knowledgeBaseId, loadPublicUrls]);

  async function openPreviewPath(logicalPath: string, title: string) {
    setSelectedFilePath(logicalPath);
    setSelectedFileTitle(title);
    setRelationships([]);
    setSelectedSourceFileId(null);
    setPreviewHtml("");
    setPreviewError("");

    let detail;
    try {
      detail = await fetchKnowledgeBaseFileDetail({ knowledgeBaseId, path: logicalPath });
    } catch (error) {
      setPreviewError(readErrorMessageKey(error));
      return;
    }
    if (!detail) {
      setPreviewError("errors.notFound");
      return;
    }

    setSelectedFileTitle(detail.file.title || title);
    setRelationships(detail.relationships);
    setSelectedSourceFileId(detail.file.sourceFileId);
    setPreviewHtml(
      detail.file.contentType.includes("markdown") || logicalPath.endsWith(".md")
        ? renderMarkdownPreview(detail.content, logicalPath)
        : renderGeneratedTextPreview(detail.content, {
            contentType: detail.file.contentType,
            logicalPath
          })
    );
  }

  async function copyUrl(url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(url);
  }

  return {
    clearSelectedFile,
    copiedUrl,
    copyUrl,
    loadPublicUrls,
    openPreviewPath,
    previewError,
    previewHtml,
    publicUrls,
    publicUrlsError,
    relationships,
    selectedFilePath,
    selectedFileTitle,
    selectedSourceFileId
  };
}

function readErrorMessageKey(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "errors.serviceUnavailable";
}
