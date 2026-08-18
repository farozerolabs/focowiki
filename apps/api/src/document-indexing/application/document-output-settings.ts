import type { OrderedDirectoryLeafLimits } from
  "../domain/document-directory-leaves.js";
import type { StorageVnextRuntimeSettingsRevisionDocument } from
  "../../runtime-settings/revision-document.js";
import type {
  RuntimeGeneratedSettings,
  RuntimeGraphSettings,
  RuntimeSemanticSettings,
  RuntimeSearchSettings
} from "../../runtime-settings/types.js";
import {
  sanitizeGeneratedSettings,
  sanitizeGraphSettings,
  sanitizeSemanticSettings,
  sanitizeSearchSettings,
  validateGeneratedSettings,
  validateGraphSettings,
  validateSemanticSettings,
  validateSearchSettings
} from "../../runtime-settings/validation.js";

export function resolvePinnedDocumentOutputSettings(
  document: StorageVnextRuntimeSettingsRevisionDocument
): {
  generated: RuntimeGeneratedSettings;
  graph: RuntimeGraphSettings;
  semantic: RuntimeSemanticSettings;
  search: RuntimeSearchSettings;
  directoryLeafLimits: OrderedDirectoryLeafLimits;
} {
  const generated = requireSection(document.sections.generated,
    "generated_settings_revision_invalid");
  const graph = requireSection(document.sections.graph,
    "graph_settings_revision_invalid");
  const search = requireSection(document.sections.search,
    "search_settings_revision_invalid");
  const semantic = requireSection(document.sections.semantic,
    "semantic_settings_revision_invalid");
  if (validateGeneratedSettings(generated).length > 0
    || Number(generated.directoryIndexMaxEntries) < 2) {
    throw outputSettingsError("generated_settings_revision_invalid");
  }
  if (validateGraphSettings(graph).length > 0) {
    throw outputSettingsError("graph_settings_revision_invalid");
  }
  if (validateSearchSettings(search).length > 0) {
    throw outputSettingsError("search_settings_revision_invalid");
  }
  if (validateSemanticSettings(semantic).length > 0) {
    throw outputSettingsError("semantic_settings_revision_invalid");
  }
  const sanitizedGenerated = sanitizeGeneratedSettings(
    generated as RuntimeGeneratedSettings
  );
  return {
    generated: sanitizedGenerated,
    graph: sanitizeGraphSettings(graph as RuntimeGraphSettings),
    semantic: sanitizeSemanticSettings(semantic as RuntimeSemanticSettings),
    search: sanitizeSearchSettings(search as RuntimeSearchSettings),
    directoryLeafLimits: {
      maxEntries: sanitizedGenerated.directoryIndexMaxEntries,
      maxBytes: sanitizedGenerated.directoryIndexMaxBytes,
      mergeBelowEntries: Math.max(1,
        Math.floor(sanitizedGenerated.directoryIndexMaxEntries / 4))
    }
  };
}

function requireSection(
  value: unknown,
  code: string
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw outputSettingsError(code);
  }
  return value as Readonly<Record<string, unknown>>;
}

function outputSettingsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document output settings error: ${code}`), { code });
}
