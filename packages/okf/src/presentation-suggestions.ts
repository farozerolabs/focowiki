import type { SourceMetadata } from "./metadata.js";

export type PresentationSuggestions = {
  description?: string | null;
} | null;

export function applyPresentationSuggestions(
  metadata: SourceMetadata,
  suggestions: PresentationSuggestions
): SourceMetadata {
  const description = cleanDescription(suggestions?.description);

  if (!description) {
    return metadata;
  }

  if (cleanDescription(metadata.description)) {
    return metadata;
  }

  return { ...metadata, description };
}

function cleanDescription(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
