import type { SourceMetadata, SourceMetadataDefaults, SourceModelSuggestions } from "@focowiki/okf";
import { applyPresentationSuggestions, isLowInformationSharedGraphTerm } from "@focowiki/okf";

export type SourceContentProfile = {
  summary: string;
  description: string;
  subjects: string[];
  keywords: string[];
  tags: string[];
  entities: string[];
  explicitReferences: string[];
  relationshipHints: string[];
  definitions: string[];
  processHints: string[];
  versionHints: string[];
  evidencePhrases: string[];
  headingOutline: string[];
  language: "zh" | "en" | "mixed" | "unknown";
  sourceExcerpt: string;
  profileVersion: string;
  profileSource: "deterministic";
};

export const CONTENT_PROFILE_VERSION = "content-profile-v1";
export const CONTENT_PROFILE_SOURCE_CHAR_LIMIT = 200_000;
export const CONTENT_PROFILE_SOURCE_LINE_LIMIT = 5_000;

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
  const sourceBody = stripGeneratedSections(limitProfileSourceBody(input.body));
  const plainText = markdownToText(sourceBody);
  const narrativeText = markdownToText(removeMarkdownHeadings(sourceBody)) || plainText;
  const headingOutline = extractSourceHeadings(sourceBody);
  const titleTerms = extractTitleTerms(input.title);
  const headingTerms = headingOutline.flatMap(extractTitleTerms);
  const titleConcepts = extractConceptTerms(input.title, true);
  const headingConcepts = headingOutline.flatMap((heading) => extractConceptTerms(heading, true));
  const metadataTags = readStringArray(input.metadata.tags);
  const suggestionTags = readStringArray(input.suggestions?.tags);
  const suggestionKeywords = readStringArray(input.suggestions?.keywords);
  const effectiveMetadata = applyPresentationSuggestions(
    toResolvedProfileMetadata(input.metadata, input.title),
    input.suggestions,
    { body: sourceBody }
  );
  const sentences = extractSentences(removeMarkdownHeadings(sourceBody));
  const definitions = extractDefinitionPhrases(sentences);
  const processHints = extractProcessHints(sentences, headingOutline);
  const versionHints = extractVersionHints(sentences, headingOutline);
  const metadataDescription = readString(effectiveMetadata.description);
  const contentDescription = selectSubstantiveDescription(sentences, narrativeText);
  const description = contentDescription || metadataDescription;
  const quotedPhrases = extractQuotedPhrases(narrativeText);
  const coreQuotedPhrases = quotedPhrases.filter(
    (phrase) => !versionHints.some((hint) => normalizeTerm(hint).includes(normalizeTerm(phrase)))
  );
  const evidencePhrases = extractEvidencePhrases(sentences);
  const contentHintPhrases = unique([
    ...definitions,
    ...processHints,
    ...versionHints,
    ...evidencePhrases
  ]);
  const keywords = unique([
    ...titleTerms,
    ...headingTerms,
    ...coreQuotedPhrases.flatMap(extractTitleTerms),
    ...contentHintPhrases.flatMap(extractTitleTerms),
    ...extractLatinTerms(narrativeText),
    ...extractCjkTerms(narrativeText),
    ...headingOutline.flatMap((heading) => [...extractLatinTerms(heading), ...extractTitleTerms(heading)]),
    ...suggestionKeywords.flatMap((keyword) => [...extractLatinTerms(keyword), ...extractCjkTerms(keyword)])
  ])
    .filter(isUsefulTerm)
    .slice(0, 80);
  const subjects = unique([
    ...titleConcepts,
    ...headingConcepts,
    ...coreQuotedPhrases.flatMap((phrase) => extractConceptTerms(phrase))
  ])
    .filter(isUsefulTerm)
    .slice(0, 24);
  const entities = unique([
    ...titleConcepts,
    ...headingConcepts,
    ...coreQuotedPhrases,
    ...extractCapitalizedPhrases(narrativeText)
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
    ...definitions,
    ...processHints,
    ...versionHints
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
    definitions,
    processHints,
    versionHints,
    evidencePhrases,
    headingOutline,
    language: detectLanguage(plainText),
    sourceExcerpt: plainText.slice(0, 2_000),
    profileVersion: CONTENT_PROFILE_VERSION,
    profileSource: "deterministic"
  };
}

function limitProfileSourceBody(body: string): string {
  const boundedChars =
    body.length > CONTENT_PROFILE_SOURCE_CHAR_LIMIT
      ? body.slice(0, CONTENT_PROFILE_SOURCE_CHAR_LIMIT)
      : body;
  const lines = boundedChars.split(/\r?\n/u);

  if (lines.length <= CONTENT_PROFILE_SOURCE_LINE_LIMIT) {
    return boundedChars;
  }

  return lines.slice(0, CONTENT_PROFILE_SOURCE_LINE_LIMIT).join("\n");
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

function removeMarkdownHeadings(body: string): string {
  return body
    .split(/\r?\n/u)
    .filter((line) => !parseHeading(line))
    .join("\n");
}

export function isUsefulTerm(value: string): boolean {
  const normalized = normalizeTerm(value);
  return (
    normalized.length >= 2 &&
    !LOW_INFORMATION_TERMS.has(normalized) &&
    !isLowInformationSharedGraphTerm(normalized) &&
    !hasFormattingArtifactShape(normalized)
  );
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

function selectSubstantiveDescription(sentences: string[], fallback: string): string {
  const substantive = sentences.find((sentence) => !isVersionContext(sentence));

  return substantive || sentences[0] || fallback.slice(0, 240);
}

function extractSentences(value: string): string[] {
  return unique(
    value
      .split(/\r?\n/u)
      .filter((line) => !parseHeading(line))
      .flatMap((line) => markdownToText(line).match(/[^。！？.!?]+[。！？.!?]?/gu) ?? [])
      .map((sentence) => sentence.replace(/^[)\]】）]+\s*/u, "").trim())
      .filter((sentence) => sentence.length >= 12)
      .filter((sentence) => !isStructuralOutlineLine(sentence))
  ).slice(0, 80);
}

function isStructuralOutlineLine(value: string): boolean {
  const normalized = value.replace(/\s+/gu, " ").trim();

  if (/^(?:\u76ee\s*\u5f55|\u7b2c[\u4e00-\u9fa5\d]+[\u7ae0\u8282\u7f16\u5377\u7bc7\u90e8])(?:\s|$)/u.test(normalized)) {
    return true;
  }

  return /^(?:table of contents|(?:chapter|section)\s+[a-z0-9]+(?:\s+.+)?)$/iu.test(normalized);
}

function extractDefinitionPhrases(sentences: string[]): string[] {
  return sentences
    .filter((sentence) =>
      /\b(?:means|refers to|is defined as|are defined as|definition of)\b/iu.test(sentence) ||
      /(?:\u662f\u6307|\u5b9a\u4e49\u4e3a|\u79f0\u4e3a)/u.test(sentence)
    )
    .map(truncatePhrase)
    .slice(0, 12);
}

function extractProcessHints(sentences: string[], headings: string[]): string[] {
  return unique([...headings, ...sentences])
    .filter((value) =>
      /\b(?:process|procedure|workflow|step|phase|before|after|approval|review|retry|fallback)\b/iu.test(value) ||
      /(?:\u6d41\u7a0b|\u6b65\u9aa4|\u7a0b\u5e8f|\u9636\u6bb5|\u5ba1\u6279|\u590d\u6838|\u5904\u7406|\u91cd\u8bd5)/u.test(value)
    )
    .map(truncatePhrase)
    .slice(0, 16);
}

function extractVersionHints(sentences: string[], headings: string[]): string[] {
  return unique([...headings, ...sentences])
    .filter(isVersionContext)
    .map(truncateVersionHint)
    .slice(0, 12);
}

function isVersionContext(value: string): boolean {
  const normalized = value.trim();

  return (
    /\b(?:version\s*[a-z0-9]|changelog|deprecated|superseded|release\s*[a-z0-9]|updated\s+(?:in|on|at|under|by|from|to)|revised\s+(?:in|on|at|under|by|from|to)|effective\s+(?:from|on)|status\s*:)/iu.test(
      normalized
    ) ||
    /(?:\u7248\u672c\s*[A-Za-z0-9]|\u66f4\u65b0(?:\u4e8e|\u65f6\u95f4|\u65e5\u671f|\u8bb0\u5f55|\u8bf4\u660e)|\u4fee\u8ba2(?:\u4e8e|\u65f6\u95f4|\u65e5\u671f|\u8bb0\u5f55|\u8bf4\u660e)|\u751f\u6548(?:\u4e8e|\u65f6\u95f4|\u65e5\u671f)|\u5931\u6548(?:\u4e8e|\u65f6\u95f4|\u65e5\u671f)|\u53d1\u5e03(?:\u4e8e|\u65f6\u95f4|\u65e5\u671f|\u8bb0\u5f55)|\u66ff\u4ee3(?:\u7248\u672c|\u6587\u4ef6))/u.test(normalized) ||
    (/^[\s(\uff08\[]*\d{4}\s*\u5e74/u.test(normalized) &&
      /(?:\u901a\u8fc7|\u6279\u51c6|\u516c\u5e03|\u53d1\u5e03|\u4fee\u8ba2|\u4fee\u6b63|\u751f\u6548)/u.test(normalized))
  );
}

function truncateVersionHint(value: string): string {
  const trimmed = value.trim();
  const closingIndex = /^[\s(\uff08\[]/u.test(trimmed)
    ? trimmed.search(/[)\uff09\]]/u)
    : -1;

  if (closingIndex >= 0) {
    return trimmed.slice(0, closingIndex + 1).slice(0, 240);
  }

  return truncatePhrase(trimmed);
}

function extractEvidencePhrases(sentences: string[]): string[] {
  return sentences
    .filter(
      (sentence) =>
        !/^(?:related|citations|references)\b/iu.test(sentence) &&
        !isVersionContext(sentence)
    )
    .map(truncatePhrase)
    .slice(0, 8);
}

function truncatePhrase(value: string): string {
  return value.trim().slice(0, 240);
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

  const cjkSegments = Array.from(segmenter.segment(value), (segment) => segment.segment)
    .map((segment) => segment.trim())
    .filter((segment) => /^[\p{Script=Han}]+$/u.test(segment))
    .filter((segment) => segment.length > 0);

  if (cjkSegments.some((segment) => segment.length === 1)) {
    return value.length >= 3 && value.length <= 18 ? [value] : [];
  }

  return cjkSegments
    .filter((segment) => isUsefulTerm(segment));
}

function extractTitleTerms(value: string): string[] {
  return [...extractLatinTerms(value), ...extractCjkTerms(value)].map(normalizeTerm);
}

function extractConceptTerms(value: string, expandShortTitle = false): string[] {
  const latinTerms = extractLatinTerms(value);
  const cjkTerms = (value.match(/[\p{Script=Han}]{2,80}/gu) ?? []).flatMap((chunk) => {
    const stripped = stripDocumentSuffix(chunk);
    const expanded = expandShortTitle && chunk.length <= 30
      ? adjacentConceptPairs(segmentCjkWords(stripped || chunk))
      : [];
    return unique([
      chunk,
      ...(stripped && stripped !== chunk ? [stripped] : []),
      ...expanded
    ]);
  });

  return unique([...latinTerms, ...cjkTerms]).map(normalizeTerm).filter(isUsefulTerm);
}

function adjacentConceptPairs(words: string[]): string[] {
  const pairs: string[] = [];

  for (let index = 0; index + 1 < words.length; index += 1) {
    const pair = `${words[index]}${words[index + 1]}`;

    if (pair.length >= 4 && pair.length <= 16 && isUsefulTerm(pair)) {
      pairs.push(pair);
    }
  }

  return pairs;
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

function hasFormattingArtifactShape(value: string): boolean {
  return /^(?:mergeformat|hyperlink|pageref|ref|seq|toc|xe|tc)\d*$/iu.test(value);
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
