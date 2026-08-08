export const OKF_CONFORMANCE_BASELINE = {
  version: "0.2",
  announcementUrl:
    "https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals",
  specificationUrl:
    "https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/930b65fc3f5619d5d0591f88c72ebae8b848d60d/okf/SPEC.md",
  repositoryRevision: "930b65fc3f5619d5d0591f88c72ebae8b848d60d",
  retrievedAt: "2026-08-07"
} as const;

export const OKF_V02_AUDIT_BASELINE = OKF_CONFORMANCE_BASELINE;

export const OKF_V02_REFERENCE_DIFFERENCES = [{
  path: "okf/bundles/acme_retail/log.md",
  ruleId: "OKF-0.2-LOG-STRUCTURE",
  observation:
    "The pinned sample uses concept frontmatter and a Bundle history heading although SPEC sections 9 and 11 require the reserved log structure."
}] as const;

export const OKF_V02_RULE_AUDIT_BASELINE = [
  auditRule("OKF-0.2-CONCEPT-FRONTMATTER", "official_must", "4, 11", "concept-validation"),
  auditRule("OKF-0.2-CONCEPT-TYPE", "official_must", "4.1, 11", "concept-validation"),
  auditRule("OKF-0.2-RESERVED-FILENAME", "official_must", "3.1, 11", "reserved-file-validation"),
  auditRule("OKF-0.2-INDEX-STRUCTURE", "official_must", "8, 11, 12", "reserved-file-validation"),
  auditRule("OKF-0.2-LOG-STRUCTURE", "official_must", "9, 11", "reserved-file-validation"),
  auditRule("OKF-0.2-UNKNOWN-FIELDS", "official_must", "4.1, 11", "v02/parsing"),
  auditRule("OKF-0.2-VERIFIED-MAPPING", "official_must", "5.2, 11", "v02/verification"),
  auditRule("OKF-0.2-MISSING-OPTIONAL", "official_must", "5.3, 11", "v02/parsing"),
  auditRule("OKF-0.2-BROKEN-LINK-TOLERANCE", "official_must", "6.1, 11", "v02/provenance"),
  auditRule("OKF-0.2-FUTURE-VERSION", "official_should", "12", "v02/profile"),
  auditRule("OKF-0.2-SOURCES", "official_should", "5.1", "v02/provenance"),
  auditRule("OKF-0.2-GENERATED", "official_should", "5.2", "v02/parsing"),
  auditRule("OKF-0.2-TRUST-TIERS", "official_should", "5.3", "v02/verification"),
  auditRule("OKF-0.2-LIFECYCLE", "official_should", "5.4, 5.5", "v02/lifecycle"),
  auditRule("OKF-0.2-ACTOR-CONVENTION", "official_should", "7", "v02/actors"),
  auditRule("OKF-0.2-ATTESTED-COMPUTATION", "official_should", "10", "v02/attested-computation"),
  auditRule("OKF-0.2-LEGACY-TIMESTAMP", "official_should", "13.1", "v02/parsing"),
  auditRule("OKF-0.2-LEGACY-CITATIONS", "official_should", "13.1", "markdown-appendix")
] as const;

function auditRule(
  ruleId: string,
  classification: "official_must" | "official_should",
  specificationSection: string,
  implementationBoundary: string
) {
  return { ruleId, classification, specificationSection, implementationBoundary } as const;
}

export const OKF_RESERVED_MARKDOWN_FILES = ["index.md", "log.md"] as const;
export const OKF_CONCEPT_ROLES = [
  "reserved_navigation",
  "source_backed_concept",
  "generated_extension_concept"
] as const;

export const OKF_NORMATIVE_RULES = [
  "OKF-0.2-CONCEPT-FRONTMATTER",
  "OKF-0.2-CONCEPT-TYPE",
  "OKF-0.2-RESERVED-FILENAME",
  "OKF-0.2-INDEX-STRUCTURE",
  "OKF-0.2-LOG-STRUCTURE",
  "OKF-0.2-UNKNOWN-FIELDS",
  "OKF-0.2-VERIFIED-MAPPING",
  "OKF-0.2-MISSING-OPTIONAL",
  "OKF-0.2-BROKEN-LINK-TOLERANCE"
] as const;

export const OKF_RECOMMENDED_RULES = [
  "OKF-0.2-FUTURE-VERSION",
  "OKF-0.2-SOURCES",
  "OKF-0.2-GENERATED",
  "OKF-0.2-TRUST-TIERS",
  "OKF-0.2-LIFECYCLE",
  "OKF-0.2-ACTOR-CONVENTION",
  "OKF-0.2-ATTESTED-COMPUTATION",
  "OKF-0.2-LEGACY-TIMESTAMP",
  "OKF-0.2-LEGACY-CITATIONS"
] as const;

export const OKF_PRODUCER_RULES = [
  "FOCOWIKI-QUALITY-STANDARD-MARKDOWN-LINKS",
  "FOCOWIKI-QUALITY-TITLE",
  "FOCOWIKI-QUALITY-NAVIGATION",
  "FOCOWIKI-QUALITY-GENERATED-TARGET",
  "FOCOWIKI-QUALITY-GENERATED-IDENTITY",
  "FOCOWIKI-QUALITY-PROGRESSIVE-DISCLOSURE",
  "FOCOWIKI-EXTENSION-NAVIGATION"
] as const;

export type OkfNormativeRule = (typeof OKF_NORMATIVE_RULES)[number];
export type OkfRecommendedRule = (typeof OKF_RECOMMENDED_RULES)[number];
export type OkfProducerRule = (typeof OKF_PRODUCER_RULES)[number];
export type OkfRuleId = OkfNormativeRule | OkfRecommendedRule | OkfProducerRule;
export type OkfRuleClassification = "official_must" | "official_should" | "producer";

export type OkfConformanceRuleMatrixEntry = {
  ruleId: OkfRuleId;
  classification: OkfRuleClassification;
  specificationSection: string;
  implementation: string;
  validatorAssertion: string;
  positiveFixture: string;
  negativeFixture: string;
  generatedExample: string;
  manualReviewEvidence: string;
};

const GENERATED_EXAMPLE = "apps/api/test/okf-v02-red.test.ts";

export const OKF_CONFORMANCE_RULE_MATRIX = [
  ...OKF_V02_RULE_AUDIT_BASELINE.map((rule) => ({
    ruleId: rule.ruleId as OkfNormativeRule | OkfRecommendedRule,
    classification: rule.classification,
    specificationSection: rule.specificationSection,
    implementation: `packages/okf/src/${rule.implementationBoundary}.ts`,
    validatorAssertion: assertionForRule(rule.ruleId),
    positiveFixture: "pinned official OKF 0.2 bundle or generated concept fixture",
    negativeFixture: "table-driven source advisory and Focowiki-owned blocking fixture",
    generatedExample: GENERATED_EXAMPLE,
    manualReviewEvidence: "pinned official bundle and generated release comparison"
  })),
  ...OKF_PRODUCER_RULES.map((ruleId) => ({
    ruleId,
    classification: "producer" as const,
    specificationSection: "Focowiki producer profile",
    implementation: implementationForProducerRule(ruleId),
    validatorAssertion: assertionForRule(ruleId),
    positiveFixture: "canonical generated OKF 0.2 release",
    negativeFixture: "generated-output ownership or navigation defect fixture",
    generatedExample: GENERATED_EXAMPLE,
    manualReviewEvidence: "Focowiki generated-output review"
  }))
] as const satisfies readonly OkfConformanceRuleMatrixEntry[];

function assertionForRule(ruleId: string): string {
  if (ruleId.includes("INDEX-STRUCTURE")) return "Reserved index files follow OKF 0.2 structure.";
  if (ruleId.includes("LOG-STRUCTURE")) return "Reserved log files follow OKF 0.2 structure.";
  if (ruleId.includes("CONCEPT-FRONTMATTER")) return "Concept YAML is parseable when present.";
  if (ruleId.includes("CONCEPT-TYPE")) return "Conforming concepts use a non-empty type.";
  if (ruleId.startsWith("FOCOWIKI-")) return "Focowiki-owned output satisfies its producer-quality gate.";
  return "Safe source gaps remain advisory while Focowiki-owned producer defects block activation.";
}

function implementationForProducerRule(ruleId: OkfProducerRule): string {
  return ruleId.includes("TITLE")
    ? "packages/okf/src/concept-validation.ts"
    : "packages/okf/src/generated-link-validation.ts";
}
