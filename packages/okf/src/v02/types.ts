import type { SourceMetadataDefaults } from "../metadata.js";

export type OkfOwnership = "source" | "focowiki";
export type OkfV02RuleClassification = "normative" | "recommended" | "extension";
export type OkfProductDisposition = "advisory" | "blocking";
export type OkfEffectiveStatus = "draft" | "stable" | "deprecated";
export type OkfTrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export type OkfDiagnostic = {
  ruleId: string;
  classification: OkfV02RuleClassification;
  disposition: OkfProductDisposition;
  path: string;
  messageKey: string;
};

export type OkfDecisionSignals = {
  effectiveStatus: OkfEffectiveStatus | null;
  trustTier: OkfTrustTier | null;
  isStale: boolean | null;
  staleAfter: string | null;
  generatedAt: string | null;
  generatedAtSource: "generated" | "legacy_timestamp" | null;
  latestVerifiedAt: string | null;
  sourceCount: number | null;
};

export type OkfUsageWindow = {
  from: string | null;
  to: string | null;
};

export type OkfSource = Record<string, unknown> & {
  id: string;
  resource: string;
  usage_window?: OkfUsageWindow;
};

export type OkfVerificationEvent = Record<string, unknown> & {
  by: string;
  at: string;
};

export type OkfComputationParameter = {
  name: string;
  type: string;
  required: boolean;
};

export type OkfAttestedComputation = {
  complete: boolean;
  runtime: string | null;
  parameters: OkfComputationParameter[];
  computation: {
    kind: "inline" | "resource";
    resource: string | null;
  } | null;
  executor: {
    resource: string;
    receipt: string[];
  } | null;
  attester: {
    resource: string;
  } | null;
};

export type OkfMetadataAnalysis = {
  metadata: SourceMetadataDefaults;
  signals: OkfDecisionSignals;
  diagnostics: OkfDiagnostic[];
  attestedComputation: OkfAttestedComputation | null;
};

export type AnalyzeOkfMetadataOptions = {
  ownership?: OkfOwnership;
  today?: string;
  markdownBody?: string;
  candidatePaths?: readonly string[];
};

export type OkfPublicationMetadataInput = {
  ownership: OkfOwnership;
  metadata: SourceMetadataDefaults;
  artifactKind?: "concept" | "bundle_root";
  changedAt?: string;
};
