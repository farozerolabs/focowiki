import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false
});

const defaultLinkOpen =
  markdownRenderer.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
const defaultLinkClose =
  markdownRenderer.renderer.rules.link_close ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdownRenderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const href = token?.attrGet("href");
  const previewPath = href ? readInternalPreviewPath(href) : null;

  if (!previewPath) {
    const safeHref = href ? sanitizeExternalHref(href) : null;

    if (!safeHref && href) {
      token?.attrSet("href", "");
    }

    if (safeHref) {
      token?.attrSet("href", safeHref);
      token?.attrSet("target", "_blank");
      token?.attrSet("rel", "noreferrer");
    }

    return defaultLinkOpen(tokens, index, options, env, self);
  }

  return `<button type="button" class="inline border-0 bg-transparent p-0 font-medium text-primary underline underline-offset-4" data-preview-path="${escapeHtml(previewPath)}">`;
};

markdownRenderer.renderer.rules.link_close = (tokens, index, options, env, self) => {
  const openingToken = findOpeningLinkToken(tokens, index);
  const href = openingToken?.attrGet?.("href");

  if (href && readInternalPreviewPath(href)) {
    return "</button>";
  }

  return defaultLinkClose(tokens, index, options, env, self);
};

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderMarkdownPreview(markdown: string) {
  return DOMPurify.sanitize(markdownRenderer.render(renderFrontmatterAsCode(markdown)), {
    ADD_ATTR: ["data-preview-path", "target", "rel"],
    ADD_TAGS: ["button"]
  });
}

function renderFrontmatterAsCode(markdown: string) {
  return markdown.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/, (_match, frontmatter) =>
    ["```yaml", String(frontmatter).trimEnd(), "```", ""].join("\n")
  );
}

function findOpeningLinkToken(tokens: unknown[], closeIndex: number) {
  for (let index = closeIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index] as { type?: string; attrGet?: (name: string) => string | null };

    if (token?.type === "link_open") {
      return token;
    }
  }

  return null;
}

function readInternalPreviewPath(href: string) {
  const normalized = decodePreviewPath(href.trim())
    .replace(/^\/+/, "")
    .replace(/#.*$/, "");

  if (
    normalized === "index.md" ||
    normalized === "schema.md" ||
    normalized.startsWith("pages/") ||
    normalized.startsWith("_index/")
  ) {
    return normalized;
  }

  return null;
}

function sanitizeExternalHref(href: string) {
  const trimmed = href.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
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
