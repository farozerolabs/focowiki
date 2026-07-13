import type { SourceMetadata } from "./metadata.js";

export type PresentationSuggestions = {
  description?: string | null;
} | null;

export type PresentationContext = {
  body?: string;
  fileName?: string;
};

const MAX_DESCRIPTION_LENGTH = 500;
const MAX_FALLBACK_LENGTH = 320;
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const TERMINAL_PUNCTUATION = /[.!?;:。！？；：]+$/u;
const STRUCTURAL_PARAGRAPH = /^(?:#{1,6}\s|[-*+]\s|>\s|```|~~~|\||<)/u;
const SCRIPT_PATTERNS = [
  ["latin", /\p{Script=Latin}/gu],
  ["cyrillic", /\p{Script=Cyrillic}/gu],
  ["han", /\p{Script=Han}/gu],
  ["hiragana", /\p{Script=Hiragana}/gu],
  ["katakana", /\p{Script=Katakana}/gu],
  ["hangul", /\p{Script=Hangul}/gu],
  ["arabic", /\p{Script=Arabic}/gu],
  ["hebrew", /\p{Script=Hebrew}/gu],
  ["devanagari", /\p{Script=Devanagari}/gu]
] as const;
const MIN_SCRIPT_SAMPLE_SIZE = 20;
const DOMINANT_SCRIPT_RATIO = 0.7;

export function applyPresentationSuggestions(
  metadata: SourceMetadata,
  suggestions: PresentationSuggestions,
  context: PresentationContext = {}
): SourceMetadata {
  return resolvePresentationMetadata({ metadata, suggestions, ...context });
}

export function resolvePresentationMetadata(input: {
  metadata: SourceMetadata;
  suggestions: PresentationSuggestions;
  body?: string;
  fileName?: string;
}): SourceMetadata {
  const producerDescription = cleanDescription(input.metadata.description);
  const suggestedDescription = cleanSuggestedDescription(
    input.suggestions?.description,
    input.body ?? ""
  );
  const fileStem = input.fileName ? filenameStem(input.fileName) : "";
  const producerIsInformative = producerDescription
    && !isEquivalent(producerDescription, input.metadata.title)
    && (!fileStem || !isEquivalent(producerDescription, fileStem));

  if (producerIsInformative) {
    return input.metadata;
  }

  const description = suggestedDescription || extractFallbackParagraph(input.body ?? "");

  if (!description) {
    if (!("description" in input.metadata)) {
      return input.metadata;
    }
    const { description: _description, ...metadata } = input.metadata;
    return metadata as SourceMetadata;
  }

  return { ...input.metadata, description };
}

function cleanDescription(value: unknown): string {
  if (typeof value !== "string" || UNSAFE_CONTROL_CHARACTER.test(value)) {
    return "";
  }
  const cleaned = value.trim().replace(/\s+/gu, " ");
  return cleaned.length > 0 && cleaned.length <= MAX_DESCRIPTION_LENGTH ? cleaned : "";
}

function cleanSuggestedDescription(value: unknown, body: string): string {
  const description = cleanDescription(value);

  if (!description) {
    return "";
  }

  const bodyScript = dominantScript(body);
  const descriptionScript = dominantScript(description);
  return bodyScript && descriptionScript && bodyScript !== descriptionScript ? "" : description;
}

function dominantScript(value: string): string | null {
  const counts = SCRIPT_PATTERNS.map(([name, pattern]) => [
    name,
    value.match(pattern)?.length ?? 0
  ] as const);
  const total = counts.reduce((sum, [, count]) => sum + count, 0);

  if (total < MIN_SCRIPT_SAMPLE_SIZE) {
    return null;
  }

  const [name, count] = counts.reduce((current, candidate) =>
    candidate[1] > current[1] ? candidate : current
  );
  return count / total >= DOMINANT_SCRIPT_RATIO ? name : null;
}

function isEquivalent(left: string, right: string): boolean {
  return normalizeComparable(left) === normalizeComparable(right);
}

function normalizeComparable(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(TERMINAL_PUNCTUATION, "")
    .trim()
    .toLocaleLowerCase();
}

function filenameStem(fileName: string): string {
  const basename = fileName.replaceAll("\\", "/").split("/").at(-1) ?? fileName;
  return basename.replace(/\.md$/iu, "");
}

function extractFallbackParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/gu)) {
    const paragraph = block.trim();
    if (!paragraph || STRUCTURAL_PARAGRAPH.test(paragraph)) {
      continue;
    }
    const cleaned = cleanDescription(stripInlineMarkdown(paragraph));
    if (cleaned) {
      return cleaned.slice(0, MAX_FALLBACK_LENGTH).trimEnd();
    }
  }

  return "";
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_~]/gu, "");
}
