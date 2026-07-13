export const OKF_CONFORMANCE_BASELINE = {
  version: "0.1",
  announcementUrl:
    "https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/",
  specificationUrl:
    "https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md",
  repositoryRevision: "ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a",
  retrievedAt: "2026-07-13"
} as const;

export const OKF_RESERVED_MARKDOWN_FILES = ["index.md", "log.md"] as const;
export const OKF_CONCEPT_ROLES = [
  "reserved_navigation",
  "source_backed_concept",
  "generated_extension_concept"
] as const;

export const OKF_NORMATIVE_RULES = [
  "OKF-0.1-CONCEPT-FRONTMATTER",
  "OKF-0.1-CONCEPT-TYPE",
  "OKF-0.1-INDEX-STRUCTURE",
  "OKF-0.1-LOG-STRUCTURE"
] as const;

export const OKF_RECOMMENDED_RULES = [
  "OKF-0.1-RECOMMENDED-TITLE",
  "OKF-0.1-RECOMMENDED-DESCRIPTION",
  "OKF-0.1-RECOMMENDED-RESOURCE",
  "OKF-0.1-RECOMMENDED-TAGS",
  "OKF-0.1-RECOMMENDED-TIMESTAMP",
  "OKF-0.1-RECOMMENDED-STRUCTURED-BODY",
  "OKF-0.1-RECOMMENDED-BUNDLE-LINKS",
  "OKF-0.1-RECOMMENDED-INDEX-DESCRIPTIONS",
  "OKF-0.1-RECOMMENDED-NUMBERED-CITATIONS"
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

type OkfConformanceRuleMatrixEntry = {
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

const GENERATED_EXAMPLE = "apps/api/test/okf-publication.test.ts";

export const OKF_CONFORMANCE_RULE_MATRIX = [
  officialMust(
    "OKF-0.1-CONCEPT-FRONTMATTER",
    "4, 9",
    "Every non-reserved Markdown concept begins with parseable YAML frontmatter.",
    "concept with YAML frontmatter",
    "concept without frontmatter or with invalid YAML",
    "source-backed concept frontmatter comparison"
  ),
  officialMust(
    "OKF-0.1-CONCEPT-TYPE",
    "4.1, 9",
    "Every concept frontmatter block contains a non-empty type.",
    "concept with a non-empty type",
    "concept with a missing or empty type",
    "source-backed concept type comparison"
  ),
  officialMust(
    "OKF-0.1-INDEX-STRUCTURE",
    "3.1, 6, 9, 11",
    "Reserved index files use headings and permitted frontmatter only.",
    "root and nested index files",
    "nested index frontmatter or malformed root declaration",
    "root and nested directory index review"
  ),
  officialMust(
    "OKF-0.1-LOG-STRUCTURE",
    "3.1, 7, 9",
    "Reserved log files use the official heading and descending ISO date groups.",
    "date-grouped log without frontmatter",
    "log frontmatter, wrong heading, non-ISO group, or ascending groups",
    "root and retained log continuation review"
  ),
  officialShould("OKF-0.1-RECOMMENDED-TITLE", "4.1", "Generated concepts include a readable title."),
  officialShould("OKF-0.1-RECOMMENDED-DESCRIPTION", "4.1, 6", "Generated concepts and index entries include concise descriptions."),
  officialShould("OKF-0.1-RECOMMENDED-RESOURCE", "4.1", "Canonical resource URIs are preserved when evidence exists."),
  officialShould("OKF-0.1-RECOMMENDED-TAGS", "4.1", "Safe source tags are preserved as a YAML list."),
  officialShould("OKF-0.1-RECOMMENDED-TIMESTAMP", "4.1", "Meaningful timestamps use ISO 8601 values."),
  officialShould("OKF-0.1-RECOMMENDED-STRUCTURED-BODY", "4.2", "Generated guidance favors structured Markdown."),
  officialShould("OKF-0.1-RECOMMENDED-BUNDLE-LINKS", "5", "Generated internal links use bundle-relative Markdown paths."),
  officialShould("OKF-0.1-RECOMMENDED-INDEX-DESCRIPTIONS", "6", "Generated index entries include target descriptions."),
  officialShould("OKF-0.1-RECOMMENDED-NUMBERED-CITATIONS", "8", "Generated citation appendices use numbered Markdown links."),
  producer("FOCOWIKI-QUALITY-STANDARD-MARKDOWN-LINKS", "Generated content excludes wiki-link syntax."),
  producer("FOCOWIKI-QUALITY-TITLE", "Generated concepts expose one shared display identity."),
  producer("FOCOWIKI-QUALITY-NAVIGATION", "Generated navigation is complete and descriptive."),
  producer("FOCOWIKI-QUALITY-GENERATED-TARGET", "Every producer-generated target exists in the candidate release."),
  producer("FOCOWIKI-QUALITY-GENERATED-IDENTITY", "Generated labels and target identities agree."),
  producer("FOCOWIKI-QUALITY-PROGRESSIVE-DISCLOSURE", "Large directory navigation remains bounded and complete."),
  producer("FOCOWIKI-EXTENSION-NAVIGATION", "Continuation concepts declare their navigation-only role.")
] as const satisfies readonly OkfConformanceRuleMatrixEntry[];

function officialMust(
  ruleId: OkfNormativeRule,
  specificationSection: string,
  validatorAssertion: string,
  positiveFixture: string,
  negativeFixture: string,
  manualReviewEvidence: string
): OkfConformanceRuleMatrixEntry {
  return {
    ruleId,
    classification: "official_must",
    specificationSection,
    implementation: implementationForRule(ruleId),
    validatorAssertion,
    positiveFixture,
    negativeFixture,
    generatedExample: GENERATED_EXAMPLE,
    manualReviewEvidence
  };
}

function officialShould(
  ruleId: OkfRecommendedRule,
  specificationSection: string,
  validatorAssertion: string
): OkfConformanceRuleMatrixEntry {
  return {
    ruleId,
    classification: "official_should",
    specificationSection,
    implementation: implementationForRule(ruleId),
    validatorAssertion,
    positiveFixture: "generated concept or reserved navigation fixture",
    negativeFixture: "advisory fixture without safe recommendation evidence",
    generatedExample: GENERATED_EXAMPLE,
    manualReviewEvidence: "generated metadata and Markdown structure comparison"
  };
}

function producer(ruleId: OkfProducerRule, validatorAssertion: string): OkfConformanceRuleMatrixEntry {
  return {
    ruleId,
    classification: "producer",
    specificationSection: "Focowiki producer profile",
    implementation: implementationForRule(ruleId),
    validatorAssertion,
    positiveFixture: "canonical generated bundle fixture",
    negativeFixture: "generated-output defect fixture",
    generatedExample: GENERATED_EXAMPLE,
    manualReviewEvidence: "Focowiki generated-output review"
  };
}

function implementationForRule(ruleId: OkfRuleId): string {
  if (ruleId.includes("INDEX-STRUCTURE") || ruleId.includes("LOG-STRUCTURE")) {
    return "packages/okf/src/reserved-file-validation.ts";
  }
  if (ruleId.includes("CITATION")) {
    return "packages/okf/src/citation-validation.ts";
  }
  if (
    ruleId.includes("LINK")
    || ruleId.includes("NAVIGATION")
    || ruleId.includes("TARGET")
    || ruleId.includes("IDENTITY")
    || ruleId.includes("DISCLOSURE")
  ) {
    return "packages/okf/src/generated-link-validation.ts";
  }
  return "packages/okf/src/concept-validation.ts";
}
