import { formatDisplayFileReference } from "@/lib/display-file-name";

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderMarkdownPreview(markdown: string) {
  return stripFrontmatter(markdown)
    .split(/\n{2,}/)
    .map((block) => renderMarkdownBlock(block.trim()))
    .filter(Boolean)
    .join("\n");
}

function stripFrontmatter(markdown: string) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function renderMarkdownBlock(block: string) {
  if (!block) {
    return "";
  }

  const heading = /^(#{1,6})\s+(.+)$/.exec(block);

  if (heading) {
    const level = heading[1]?.length ?? 1;
    return `<h${level}>${renderInlineMarkdown(heading[2] ?? "")}</h${level}>`;
  }

  return `<p>${renderInlineMarkdown(block)}</p>`;
}

function renderInlineMarkdown(value: string) {
  return escapeHtml(value).replace(/\[([^\]]+)]\(([^)]+)\)/g, (_match, label, href) => {
    const safeLabel = formatDisplayFileReference(String(label));
    const previewPath = readInternalPreviewPath(String(href));

    if (previewPath) {
      return `<button type="button" class="inline border-0 bg-transparent p-0 font-medium text-primary underline underline-offset-4" data-preview-path="${escapeHtml(previewPath)}">${safeLabel}</button>`;
    }

    const safeHref = sanitizeExternalHref(String(href));

    return safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noreferrer">${safeLabel}</a>`
      : safeLabel;
  });
}

function readInternalPreviewPath(href: string) {
  const normalized = decodePreviewPath(href.trim())
    .replace(/^\/+/, "")
    .replace(/#.*$/, "");

  if (
    normalized === "index.md" ||
    normalized === "schema.md" ||
    normalized.startsWith("pages/") ||
    normalized.startsWith("sources/")
  ) {
    return normalized;
  }

  return null;
}

function sanitizeExternalHref(href: string) {
  const trimmed = href.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    return escapeHtml(trimmed);
  }

  return null;
}

function decodePreviewPath(value: string) {
  let current = value.replaceAll("&amp;", "&");

  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(current);

      if (next === current) {
        return current;
      }

      current = next;
    } catch {
      return current;
    }
  }

  return current;
}
