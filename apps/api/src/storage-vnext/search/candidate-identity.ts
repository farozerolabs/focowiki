import { createHash } from "node:crypto";
import type { SearchProviderIndexDefinition } from
  "../../application/ports/search-provider-runtime.js";

export function createStorageVnextSearchIndexUid(input: {
  indexUidPrefix: string;
  knowledgeBaseId: string;
  candidatePublicId: string;
  incarnationPublicId: string;
}): string {
  return `${createStorageVnextSearchKnowledgeBaseIndexUidPrefix(input)}`
    + `${digest(input.candidatePublicId).slice(0, 16)}_`
    + digest(input.incarnationPublicId).slice(0, 16);
}

export function createStorageVnextSearchKnowledgeBaseIndexUidPrefix(input: {
  indexUidPrefix: string;
  knowledgeBaseId: string;
}): string {
  if (
    !/^[A-Za-z0-9_-]+$/u.test(input.indexUidPrefix)
    || input.indexUidPrefix.length > 80
  ) throw new Error("Storage vNext search index prefix is invalid");
  return `${input.indexUidPrefix}_${digest(input.knowledgeBaseId).slice(0, 16)}_`;
}

export function createStorageVnextSearchTaskCorrelation(input: {
  taskKind: "create" | "documents" | "settings";
  candidatePublicId: string;
  operationPublicId?: string;
  batchOrdinal?: number;
  payloadChecksum?: string;
  settingsChecksum?: string;
}): string {
  return `search-${input.taskKind}-${digest(canonicalJson(input))}`;
}

export function createStorageVnextSearchSettingsChecksum(
  settings: SearchProviderIndexDefinition
): string {
  const normalized = {
    ...structuredClone(settings),
    typoDisabledAttributes: [...settings.typoDisabledAttributes]
  };
  normalized.typoDisabledAttributes.sort((left, right) =>
    left.localeCompare(right)
  );
  return digest(canonicalJson(normalized));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
