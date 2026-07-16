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
  const previewPath = href ? readInternalPreviewPath(href, readCurrentLogicalPath(env)) : null;

  if (!previewPath) {
    const safeHref = href ? sanitizeExternalHref(href) : null;

    if (!safeHref && href) {
      return '<span class="font-medium text-foreground">';
    }

    if (safeHref) {
      token?.attrSet("href", safeHref);
      token?.attrSet("target", "_blank");
      token?.attrSet("rel", "noopener noreferrer");
    }

    return defaultLinkOpen(tokens, index, options, env, self);
  }

  return `<button type="button" class="inline border-0 bg-transparent p-0 font-medium text-primary underline underline-offset-4" data-preview-path="${escapeHtml(previewPath)}">`;
};

markdownRenderer.renderer.rules.link_close = (tokens, index, options, env, self) => {
  const openingToken = findOpeningLinkToken(tokens, index);
  const href = openingToken?.attrGet?.("href");

  if (href && readInternalPreviewPath(href, readCurrentLogicalPath(env))) {
    return "</button>";
  }

  if (href && !sanitizeExternalHref(href)) {
    return "</span>";
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

export function renderMarkdownPreview(markdown: string, currentLogicalPath = "index.md") {
  return DOMPurify.sanitize(markdownRenderer.render(
    renderFrontmatterAsCode(markdown),
    { currentLogicalPath }
  ), {
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

function readInternalPreviewPath(href: string, currentLogicalPath: string) {
  const decodedPath = decodePreviewPath(href.trim());
  if (!decodedPath) return null;
  const decoded = decodedPath.split(/[?#]/u, 1)[0] ?? "";
  if (!decoded || hasUriScheme(decoded) || decoded.startsWith("//") || decoded.includes("\\")) {
    return null;
  }

  const current = normalizeBundlePath(currentLogicalPath, []);
  if (!current) return null;
  const base = decoded.startsWith("/") ? [] : current.split("/").slice(0, -1);
  const normalized = normalizeBundlePath(decoded.replace(/^\/+/, ""), base);
  if (!normalized || !isPreviewableBundlePath(normalized)) return null;
  return normalized;
}

function sanitizeExternalHref(href: string) {
  const trimmed = href.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function readCurrentLogicalPath(env: unknown) {
  if (!env || typeof env !== "object") return "index.md";
  const value = (env as { currentLogicalPath?: unknown }).currentLogicalPath;
  return typeof value === "string" && value.trim() ? value.trim() : "index.md";
}

function normalizeBundlePath(value: string, base: string[]) {
  const segments = [...base];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    if (segment.includes("\0")) return null;
    segments.push(segment);
  }
  return segments.join("/") || null;
}

function isPreviewableBundlePath(value: string) {
  if (value.startsWith("pages/") || value.startsWith("_index/") || value.startsWith("_graph/")) {
    return hasPreviewableExtension(value);
  }
  return /^(?:index|schema(?:-[a-z0-9-]+)?|log(?:-\d{6})?)\.md$/iu.test(value);
}

function hasPreviewableExtension(value: string) {
  return /\.(?:md|json|jsonl)$/iu.test(value);
}

function hasUriScheme(value: string) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value);
}

function decodePreviewPath(value: string): string | null {
  let current = value.replaceAll("&amp;", "&");

  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(current);

      if (next === current) {
        return current;
      }

      current = next;
    } catch {
      return null;
    }
  }

  try {
    return decodeURIComponent(current) === current ? current : null;
  } catch {
    return null;
  }
}
