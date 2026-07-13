import type { OkfGraphNode } from "@focowiki/okf";
import { isUsefulTerm, normalizeTerm } from "./content-profile.js";

export function extractSearchTerms(value: string): string[] {
  return unique(
    value
      .split(/[^\p{L}\p{N}]+/u)
      .map(normalizeTerm)
      .filter(isUsefulTerm)
  );
}

export function extractPathTerms(path: string): string[] {
  return unique(
    normalizePublicPath(path)
      .split("/")
      .flatMap((part) => extractSearchTerms(stripMarkdownExtension(part)))
      .filter((term) => term !== "pages")
  );
}

export function intersectUseful(left: string[], right: string[]): string[] {
  return intersect(
    left.map(normalizeTerm).filter(isUsefulTerm),
    right.map(normalizeTerm).filter(isUsefulTerm)
  );
}

export function normalizeSearchText(value: string): string {
  return normalizeTerm(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizePublicPath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/#.*$/u, "");
}

export function readDirectoryPath(path: string): string {
  const normalized = normalizePublicPath(path);
  const index = normalized.lastIndexOf("/");

  return index > 0 ? normalized.slice(0, index) : "";
}

export function stripMarkdownExtension(fileName: string): string {
  return fileName.replace(/\.md$/iu, "");
}

export function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function readContentProfileStringArray(node: OkfGraphNode, key: string): string[] {
  return readStringArray(readRecord(node.metadata?.contentProfile)[key]);
}

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function intersect(left: string[], right: string[]): string[] {
  const rightValues = new Set(right.map(normalizeTerm));

  return unique(left.filter((value) => rightValues.has(normalizeTerm(value))));
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
