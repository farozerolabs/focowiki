import { analyzeOkfAttestedComputation } from "./attested-computation.js";
import { normalizeOkfDateOnly, normalizeOkfDateTime } from "./dates.js";
import { analyzeOkfLifecycle } from "./lifecycle.js";
import { OKF_V02_MAX_DIAGNOSTICS } from "./profile.js";
import { analyzeOkfProvenance } from "./provenance.js";
import type {
  AnalyzeOkfMetadataOptions,
  OkfDiagnostic,
  OkfMetadataAnalysis,
  OkfOwnership
} from "./types.js";
import { analyzeOkfVerification } from "./verification.js";

export function analyzeOkfMetadata(
  input: Record<string, unknown>,
  options: AnalyzeOkfMetadataOptions = {}
): OkfMetadataAnalysis {
  const ownership = options.ownership ?? "source";
  const metadata = cloneSafeRecord(input);
  const diagnostics: OkfDiagnostic[] = [];
  analyzeVersion(metadata.okf_version, ownership, diagnostics);
  analyzeType(metadata.type, ownership, diagnostics);

  const provenance = analyzeOkfProvenance({
    sources: metadata.sources,
    usageWindow: metadata.usage_window,
    sourcesPresent: Object.hasOwn(metadata, "sources"),
    ownership,
    ...(options.markdownBody === undefined ? {} : { markdownBody: options.markdownBody })
  });
  diagnostics.push(...provenance.diagnostics);
  if (provenance.sources !== null && Object.hasOwn(metadata, "sources")) {
    metadata.sources = provenance.sources;
  }

  const verification = analyzeOkfVerification({
    value: metadata.verified,
    present: Object.hasOwn(metadata, "verified"),
    ownership
  });
  diagnostics.push(...verification.diagnostics);
  if (verification.events !== null && Object.hasOwn(metadata, "verified")) {
    metadata.verified = verification.events;
  }

  const today = normalizeOkfDateOnly(options.today ?? currentUtcDate())
    ?? currentUtcDate();
  const lifecycle = analyzeOkfLifecycle({
    status: metadata.status,
    statusPresent: Object.hasOwn(metadata, "status"),
    staleAfter: metadata.stale_after,
    staleAfterPresent: Object.hasOwn(metadata, "stale_after"),
    today,
    ownership
  });
  diagnostics.push(...lifecycle.diagnostics);

  const generated = analyzeGenerated(metadata.generated, ownership);
  diagnostics.push(...generated.diagnostics);
  if (generated.value !== null) metadata.generated = generated.value;
  const legacyGeneratedAt = generated.at === null
    ? normalizeOkfDateTime(metadata.timestamp)
    : null;

  const computation = analyzeOkfAttestedComputation({
    metadata,
    ownership,
    ...(options.markdownBody === undefined ? {} : { markdownBody: options.markdownBody }),
    ...(options.candidatePaths === undefined ? {} : { candidatePaths: options.candidatePaths })
  });
  diagnostics.push(...computation.diagnostics);

  return {
    metadata: metadata as OkfMetadataAnalysis["metadata"],
    signals: {
      effectiveStatus: lifecycle.effectiveStatus,
      trustTier: verification.trustTier,
      isStale: lifecycle.isStale,
      staleAfter: lifecycle.staleAfter,
      generatedAt: generated.at ?? legacyGeneratedAt,
      generatedAtSource: generated.at !== null
        ? "generated"
        : legacyGeneratedAt !== null
          ? "legacy_timestamp"
          : null,
      latestVerifiedAt: verification.latestVerifiedAt,
      sourceCount: provenance.sourceCount
    },
    diagnostics: diagnostics.slice(0, OKF_V02_MAX_DIAGNOSTICS),
    attestedComputation: computation.contract
  };
}

function analyzeGenerated(
  value: unknown,
  ownership: OkfOwnership
): {
  value: Record<string, unknown> | null;
  at: string | null;
  diagnostics: OkfDiagnostic[];
} {
  if (value === undefined) {
    return {
      value: null,
      at: null,
      diagnostics: ownership === "focowiki" ? [generatedDiagnostic(ownership)] : []
    };
  }
  if (!isRecord(value) || typeof value.by !== "string" || value.by.length === 0) {
    return { value: null, at: null, diagnostics: [generatedDiagnostic(ownership)] };
  }
  const at = normalizeOkfDateTime(value.at);
  if (at === null) {
    return { value: null, at: null, diagnostics: [generatedDiagnostic(ownership)] };
  }
  return { value: { ...value, by: value.by, at }, at, diagnostics: [] };
}

function analyzeVersion(
  value: unknown,
  ownership: OkfOwnership,
  diagnostics: OkfDiagnostic[]
): void {
  if (value === undefined || value === "0.1" || value === "0.2") return;
  diagnostics.push({
    ruleId: "OKF-0.2-VERSION",
    classification: "extension",
    disposition: ownership === "focowiki" ? "blocking" : "advisory",
    path: "okf_version",
    messageKey: "okf.version.unknown"
  });
}

function analyzeType(
  value: unknown,
  ownership: OkfOwnership,
  diagnostics: OkfDiagnostic[]
): void {
  if (typeof value === "string" && value.length > 0) return;
  diagnostics.push({
    ruleId: "OKF-0.2-CONCEPT-TYPE",
    classification: "normative",
    disposition: ownership === "focowiki" ? "blocking" : "advisory",
    path: "type",
    messageKey: value === undefined ? "okf.type.missing" : "okf.type.invalid"
  });
}

function generatedDiagnostic(ownership: OkfOwnership): OkfDiagnostic {
  return {
    ruleId: "OKF-0.2-GENERATED",
    classification: "recommended",
    disposition: ownership === "focowiki" ? "blocking" : "advisory",
    path: "generated",
    messageKey: "okf.generated.invalid"
  };
}

function cloneSafeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
