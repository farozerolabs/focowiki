import type { SourceMetadata, SourceMetadataDefaults, SourceModelSuggestions } from "@focowiki/okf";
import { applyPresentationSuggestions } from "@focowiki/okf";

export type SourceContentProfile = {
  summary: string;
  description: string;
  subjects: string[];
  keywords: string[];
  tags: string[];
  entities: string[];
  explicitReferences: string[];
  relationshipHints: string[];
  headingOutline: string[];
  language: "zh" | "en" | "mixed" | "unknown";
  sourceExcerpt: string;
  profileVersion: string;
  profileSource: "deterministic";
};

export const CONTENT_PROFILE_VERSION = "content-profile-v1";

const GENERATED_SECTION_TITLES = new Set([
  "related",
  "citations",
  "references",
  "file graph",
  "graph references",
  "agent navigation",
  "index guidance",
  "相关",
  "引用",
  "参考",
  "文件图谱",
  "图关系"
]);

const LOW_INFORMATION_TERMS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "page",
  "file",
  "document",
  "official",
  "official source",
  "source",
  "protection",
  "effective",
  "valid",
  "related",
  "citations",
  "current",
  "本条",
  "本款",
  "本项",
  "本章",
  "本文",
  "本文件",
  "本资料",
  "本页面",
  "文档",
  "文件",
  "资料",
  "内容",
  "信息",
  "相关",
  "引用",
  "参考",
  "有效"
]);

export function buildSourceContentProfile(input: {
  title: string;
  body: string;
  metadata: SourceMetadataDefaults;
  suggestions: SourceModelSuggestions | null;
}): SourceContentProfile {
  const sourceBody = stripGeneratedSections(input.body);
  const plainText = markdownToText(sourceBody);
  const headingOutline = extractSourceHeadings(sourceBody);
  const titleTerms = extractTitleTerms(input.title);
  const headingTerms = headingOutline.flatMap(extractTitleTerms);
  const metadataTags = readStringArray(input.metadata.tags);
  const suggestionTags = readStringArray(input.suggestions?.tags);
  const suggestionKeywords = readStringArray(input.suggestions?.keywords);
  const effectiveMetadata = applyPresentationSuggestions(
    toResolvedProfileMetadata(input.metadata, input.title),
    input.suggestions
  );
  const metadataDescription = readString(effectiveMetadata.description);
  const description = metadataDescription || firstSentence(plainText);
  const quotedPhrases = extractQuotedPhrases(plainText);
  const keywords = unique([
    ...titleTerms,
    ...headingTerms,
    ...quotedPhrases.flatMap(extractTitleTerms),
    ...extractLatinTerms(plainText),
    ...extractCjkTerms(plainText),
    ...headingOutline.flatMap((heading) => [...extractLatinTerms(heading), ...extractTitleTerms(heading)]),
    ...suggestionKeywords.flatMap((keyword) => [...extractLatinTerms(keyword), ...extractCjkTerms(keyword)])
  ])
    .filter(isUsefulTerm)
    .slice(0, 80);
  const subjects = unique([
    ...titleTerms,
    ...headingTerms,
    ...quotedPhrases.flatMap(extractTitleTerms)
  ])
    .filter(isUsefulTerm)
    .slice(0, 24);
  const entities = unique([
    ...titleTerms,
    ...headingTerms,
    ...quotedPhrases,
    ...extractCapitalizedPhrases(plainText),
    ...suggestionKeywords.flatMap(extractTitleTerms)
  ])
    .filter(isUsefulTerm)
    .slice(0, 40);
  const explicitReferences = unique([
    ...extractInternalMarkdownLinkTargets(sourceBody),
    ...extractInternalMarkdownLinkLabels(sourceBody),
    ...extractUrls(sourceBody)
  ])
    .filter((value) => value.length > 0)
    .slice(0, 40);
  const relationshipHints = unique([
    ...explicitReferences,
    ...(input.suggestions?.related_links ?? []).flatMap((link) => [
      readString(link.path),
      readString(link.title)
    ])
  ])
    .filter((value) => value.length > 0)
    .slice(0, 40);

  return {
    summary: description,
    description,
    subjects,
    keywords,
    tags: unique([...metadataTags, ...suggestionTags]).filter(isUsefulTerm).slice(0, 40),
    entities,
    explicitReferences,
    relationshipHints,
    headingOutline,
    language: detectLanguage(plainText),
    sourceExcerpt: plainText.slice(0, 2_000),
    profileVersion: CONTENT_PROFILE_VERSION,
    profileSource: "deterministic"
  };
}

function toResolvedProfileMetadata(
  metadata: SourceMetadataDefaults,
  fallbackTitle: string
): SourceMetadata {
  const title = typeof metadata.title === "string" && metadata.title.trim()
    ? metadata.title
    : fallbackTitle;
  const type = typeof metadata.type === "string" && metadata.type.trim() ? metadata.type : "page";

  return {
    ...metadata,
    type,
    title
  };
}

export function stripGeneratedSections(body: string): string {
  const lines = body.split(/\r?\n/u);
  const kept: string[] = [];
  let skippingLevel: number | null = null;

  for (const line of lines) {
    const heading = parseHeading(line);

    if (heading && skippingLevel !== null && heading.level <= skippingLevel) {
      skippingLevel = null;
    }

    if (heading && isGeneratedHeading(heading.text)) {
      skippingLevel = heading.level;
      continue;
    }

    if (skippingLevel !== null) {
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n");
}

export function extractSourceHeadings(body: string): string[] {
  return unique(
    stripGeneratedSections(body)
      .split(/\r?\n/u)
      .map((line) => parseHeading(line)?.text ?? "")
      .filter(Boolean)
  ).slice(0, 50);
}

export function isUsefulTerm(value: string): boolean {
  const normalized = normalizeTerm(value);
  return normalized.length >= 2 && !LOW_INFORMATION_TERMS.has(normalized);
}

export function normalizeTerm(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/gu, " ");
}

function parseHeading(line: string): { level: number; text: string } | null {
  const match = line.match(/^(#{1,6})\s+(.+)$/u);

  if (!match) {
    return null;
  }

  return {
    level: (match[1] ?? "").length,
    text: (match[2] ?? "").replace(/#+$/u, "").trim()
  };
}

function isGeneratedHeading(value: string): boolean {
  return GENERATED_SECTION_TITLES.has(normalizeTerm(value));
}

function markdownToText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1 $2")
    .replace(/^#{1,6}\s+/gmu, " ")
    .replace(/[*_~>#|-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function firstSentence(value: string): string {
  const sentence = value.match(/^(.{12,240}?[。！？.!?])(\s|$)/u)?.[1] ?? "";
  return sentence || value.slice(0, 240);
}

function extractLatinTerms(value: string): string[] {
  return (value.match(/[a-zA-Z][a-zA-Z0-9-]{2,}/gu) ?? []).map(normalizeTerm);
}

function extractCjkTerms(value: string): string[] {
  const chunks = value.match(/[\p{Script=Han}]{2,24}/gu) ?? [];
  const terms: string[] = [];

  for (const chunk of chunks) {
    if (chunk.length <= 20) {
      terms.push(chunk);
    }

    terms.push(...extractCjkSubterms(chunk));
  }

  return terms.map(normalizeTerm);
}

function extractCjkSubterms(value: string): string[] {
  const chunk = stripDocumentSuffix(value);
  const words = segmentCjkWords(chunk);
  const terms: string[] = [];

  for (let windowSize = 1; windowSize <= 4; windowSize += 1) {
    for (let index = 0; index + windowSize <= words.length; index += 1) {
      const term = words.slice(index, index + windowSize).join("");

      if (term.length >= 3 && term.length <= 18 && isUsefulTerm(term)) {
        terms.push(term);
      }

      if (terms.length >= 24) {
        return unique(terms);
      }
    }
  }

  return unique(terms);
}

function segmentCjkWords(value: string): string[] {
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter("zh", { granularity: "word" })
      : null;

  if (!segmenter) {
    return value.length >= 3 && value.length <= 18 ? [value] : [];
  }

  return Array.from(segmenter.segment(value), (segment) => segment.segment)
    .map((segment) => segment.trim())
    .filter((segment) => /^[\p{Script=Han}]+$/u.test(segment))
    .filter((segment) => segment.length > 0)
    .filter((segment) => isUsefulTerm(segment));
}

function extractTitleTerms(value: string): string[] {
  const terms = [...extractLatinTerms(value), ...extractCjkTerms(value)];
  const cjkChunks = value.match(/[\p{Script=Han}]{3,32}/gu) ?? [];

  for (const chunk of cjkChunks) {
    const scope = chunk.match(/^(.{2,8}?(?:省|市|县|区|州|盟|旗))/u)?.[1] ?? "";

    if (scope) {
      terms.push(scope);
      const core = stripDocumentSuffix(chunk.slice(scope.length));

      if (core.length >= 4 && core.length <= 18) {
        terms.push(core);
      }
    }
  }

  return terms.map(normalizeTerm);
}

function stripDocumentSuffix(value: string): string {
  return value
    .replace(/(文档|手册|指南|规范|标准|说明|报告|方案|计划|清单|策略|流程|教程|索引)$/u, "")
    .replace(/\b(guide|manual|docs?|document|report|proposal|plan|spec|standard|policy|procedure|checklist)$/iu, "")
    .trim();
}

function extractInternalMarkdownLinkLabels(value: string): string[] {
  return extractMarkdownLinks(value)
    .filter((link) => isInternalMarkdownTarget(link.target))
    .map((link) => link.label);
}

function extractInternalMarkdownLinkTargets(value: string): string[] {
  return extractMarkdownLinks(value)
    .filter((link) => isInternalMarkdownTarget(link.target))
    .map((link) => link.target);
}

function extractMarkdownLinks(value: string): Array<{ label: string; target: string }> {
  return Array.from(value.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu), (match) => ({
    label: (match[1] ?? "").trim(),
    target: (match[2] ?? "").trim()
  }));
}

function isInternalMarkdownTarget(value: string): boolean {
  return (
    !/^https?:\/\//iu.test(value) &&
    !/^mailto:/iu.test(value) &&
    /\.md(?:#.*)?$/iu.test(value.trim())
  );
}

function extractUrls(value: string): string[] {
  return (value.match(/https?:\/\/[^\s)]+/gu) ?? []).map((url) => url.trim());
}

function extractQuotedPhrases(value: string): string[] {
  return Array.from(value.matchAll(/[“"《]([^”"》]{2,80})[”"》]/gu), (match) => (match[1] ?? "").trim());
}

function extractCapitalizedPhrases(value: string): string[] {
  return Array.from(value.matchAll(/\b[A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,4}\b/gu), (match) =>
    match[0].trim()
  );
}

function detectLanguage(value: string): SourceContentProfile["language"] {
  const hasCjk = /\p{Script=Han}/u.test(value);
  const hasLatin = /[A-Za-z]/u.test(value);

  if (hasCjk && hasLatin) {
    return "mixed";
  }

  if (hasCjk) {
    return "zh";
  }

  if (hasLatin) {
    return "en";
  }

  return "unknown";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = normalizeTerm(value);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(value.trim());
  }

  return output;
}
