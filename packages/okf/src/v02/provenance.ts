import { normalizeOkfDateOnly } from "./dates.js";
import type {
  OkfDiagnostic,
  OkfOwnership,
  OkfSource,
  OkfUsageWindow
} from "./types.js";

export type OkfProvenanceResult = {
  sources: OkfSource[] | null;
  sourceCount: number | null;
  diagnostics: OkfDiagnostic[];
};

export function analyzeOkfProvenance(input: {
  sources: unknown;
  usageWindow: unknown;
  sourcesPresent: boolean;
  ownership: OkfOwnership;
  markdownBody?: string;
}): OkfProvenanceResult {
  const diagnostics: OkfDiagnostic[] = [];
  if (!input.sourcesPresent) {
    if (input.usageWindow !== undefined && normalizeWindow(input.usageWindow) === null) {
      diagnostics.push(diagnostic(input.ownership, "usage_window", "okf.usage_window.invalid"));
    }
    return { sources: [], sourceCount: 0, diagnostics };
  }
  if (!Array.isArray(input.sources)) {
    return {
      sources: null,
      sourceCount: null,
      diagnostics: [diagnostic(input.ownership, "sources", "okf.sources.invalid")]
    };
  }

  const sharedWindow = input.usageWindow === undefined
    ? undefined
    : normalizeWindow(input.usageWindow);
  if (input.usageWindow !== undefined && sharedWindow === null) {
    diagnostics.push(diagnostic(input.ownership, "usage_window", "okf.usage_window.invalid"));
  }

  const normalized: OkfSource[] = [];
  const ids = new Set<string>();
  let invalid = false;
  for (const [index, value] of input.sources.entries()) {
    if (!isRecord(value)) {
      diagnostics.push(diagnostic(input.ownership, `sources.${index}`, "okf.sources.entry_invalid"));
      invalid = true;
      continue;
    }
    const id = readNonEmptyString(value.id);
    const resource = readNonEmptyString(value.resource);
    if (!id || !resource || ids.has(id)) {
      diagnostics.push(diagnostic(input.ownership, `sources.${index}`, "okf.sources.identity_invalid"));
      invalid = true;
      continue;
    }
    ids.add(id);
    const ownWindow = value.usage_window === undefined
      ? sharedWindow
      : normalizeWindow(value.usage_window);
    if (value.usage_window !== undefined && ownWindow === null) {
      diagnostics.push(diagnostic(
        input.ownership,
        `sources.${index}.usage_window`,
        "okf.sources.usage_window_invalid"
      ));
      invalid = true;
      continue;
    }
    if (
      value.last_modified !== undefined
      && normalizeOkfDateOnly(value.last_modified) === null
    ) {
      diagnostics.push(diagnostic(
        input.ownership,
        `sources.${index}.last_modified`,
        "okf.sources.last_modified_invalid"
      ));
      invalid = true;
      continue;
    }
    if (
      value.usage_count !== undefined
      && (!Number.isSafeInteger(value.usage_count) || Number(value.usage_count) < 0)
    ) {
      diagnostics.push(diagnostic(
        input.ownership,
        `sources.${index}.usage_count`,
        "okf.sources.usage_count_invalid"
      ));
      invalid = true;
      continue;
    }
    normalized.push({
      ...value,
      id,
      resource,
      ...(ownWindow ? { usage_window: ownWindow } : {})
    });
  }

  if (input.markdownBody !== undefined) {
    diagnostics.push(...footnoteDiagnostics(
      input.markdownBody,
      new Set(normalized.map((source) => source.id)),
      input.ownership
    ));
  }
  return invalid
    ? { sources: null, sourceCount: null, diagnostics }
    : { sources: normalized, sourceCount: normalized.length, diagnostics };
}

function normalizeWindow(value: unknown): OkfUsageWindow | null {
  if (!isRecord(value)) return null;
  const from = value.from === undefined ? null : normalizeOkfDateOnly(value.from);
  const to = value.to === undefined ? null : normalizeOkfDateOnly(value.to);
  if (
    (value.from !== undefined && from === null)
    || (value.to !== undefined && to === null)
    || (from !== null && to !== null && from > to)
  ) {
    return null;
  }
  return { from, to };
}

function footnoteDiagnostics(
  body: string,
  sourceIds: ReadonlySet<string>,
  ownership: OkfOwnership
): OkfDiagnostic[] {
  const references = new Set(Array.from(body.matchAll(/\[\^([^\]\s]+)\]/gu), (match) => match[1]!));
  const definitions = new Set(Array.from(body.matchAll(/^\[\^([^\]\s]+)\]:/gmu), (match) => match[1]!));
  const diagnostics: OkfDiagnostic[] = [];
  for (const id of references) {
    if (!sourceIds.has(id) || !definitions.has(id)) {
      diagnostics.push(diagnostic(ownership, "body.footnotes", "okf.sources.footnote_mismatch"));
      break;
    }
  }
  return diagnostics;
}

function diagnostic(
  ownership: OkfOwnership,
  path: string,
  messageKey: string
): OkfDiagnostic {
  return {
    ruleId: "OKF-0.2-PROVENANCE",
    classification: "recommended",
    disposition: ownership === "focowiki" ? "blocking" : "advisory",
    path,
    messageKey
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
