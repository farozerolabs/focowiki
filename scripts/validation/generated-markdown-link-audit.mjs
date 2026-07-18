import { createRequire } from "node:module";
import path from "node:path";
import { loadEnvFile } from "node:process";

const knowledgeBaseId = process.argv[2]?.trim();
if (!knowledgeBaseId) {
  throw new Error("Usage: node scripts/validation/generated-markdown-link-audit.mjs <knowledge-base-id>");
}

loadEnvFile(".env");

const requireFromAdmin = createRequire(path.resolve("apps/admin/package.json"));
const MarkdownIt = requireFromAdmin("markdown-it");
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
const baseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT?.trim() || "43000"}`;
const origin = process.env.ADMIN_PUBLIC_ORIGIN?.trim() || "http://127.0.0.1:43100";
let cookie = "";

await login();
const failures = [];
let internalLinkCount = 0;
let externalLinkCount = 0;
const files = [];
const markdownFiles = [];
const visited = new Set();
const queue = ["index.md"];

while (queue.length > 0) {
  const logicalPath = queue.shift();
  if (!logicalPath || visited.has(logicalPath)) continue;
  visited.add(logicalPath);
  let detail;
  try {
    detail = await requestJson(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/detail?path=${encodeURIComponent(logicalPath)}`
    );
  } catch (error) {
    failures.push({ source: null, href: logicalPath, target: logicalPath, error: String(error) });
    continue;
  }
  files.push(detail.file);
  if (!logicalPath.endsWith(".md")) continue;
  markdownFiles.push(detail.file);
  for (const href of extractMarkdownLinks(detail.content)) {
    if (hasUriScheme(href) || href.startsWith("//")) {
      externalLinkCount += 1;
      continue;
    }
    internalLinkCount += 1;
    const target = resolveBundleLink(href, logicalPath);
    if (!target) {
      failures.push({ source: logicalPath, href, target });
      continue;
    }
    if (!visited.has(target)) queue.push(target);
  }
}

console.log(JSON.stringify({
  knowledgeBaseId,
  generatedFileCount: files.length,
  markdownFileCount: markdownFiles.length,
  internalLinkCount,
  externalLinkCount,
  brokenLinkCount: failures.length,
  brokenLinks: failures.slice(0, 20)
}, null, 2));

if (failures.length > 0) process.exitCode = 1;

async function login() {
  const username = requiredEnv("ADMIN_USERNAME");
  const password = requiredEnv("ADMIN_PASSWORD");
  await requestJson("/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ username, password })
  });
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {})
    }
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0] ?? "";
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${pathname}: ${body?.error?.code ?? "UNKNOWN_ERROR"}`);
  }
  return body;
}

function extractMarkdownLinks(content) {
  const links = [];
  for (const token of markdown.parse(content, {})) {
    for (const child of token.children ?? []) {
      if (child.type !== "link_open") continue;
      const href = child.attrGet("href")?.trim();
      if (href) links.push(href);
    }
  }
  return links;
}

function resolveBundleLink(href, currentLogicalPath) {
  const decoded = decodeRepeatedly(href).split(/[?#]/u, 1)[0] ?? "";
  const current = normalizePath(currentLogicalPath, []);
  if (!current) return null;
  if (!decoded && href.startsWith("#")) return current;
  if (!decoded || decoded.includes("\\")) return null;
  const base = decoded.startsWith("/") ? [] : current.split("/").slice(0, -1);
  return normalizePath(decoded.replace(/^\/+/, ""), base);
}

function normalizePath(value, base) {
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

function decodeRepeatedly(value) {
  let current = value.replaceAll("&amp;", "&");
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) return current;
      current = next;
    } catch {
      return current;
    }
  }
  return current;
}

function hasUriScheme(value) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}
