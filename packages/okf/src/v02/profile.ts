export const OKF_V02_PROFILE = Object.freeze({
  version: "0.2",
  announcementUrl:
    "https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals",
  specificationUrl:
    "https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/930b65fc3f5619d5d0591f88c72ebae8b848d60d/okf/SPEC.md",
  repositoryRevision: "930b65fc3f5619d5d0591f88c72ebae8b848d60d",
  retrievedAt: "2026-08-07"
});

export const OKF_V02_MAX_DIAGNOSTICS = 64;

export const OKF_V02_RULE_MATRIX = Object.freeze([
  { ruleId: "OKF-0.2-CONCEPT-TYPE", classification: "normative" },
  { ruleId: "OKF-0.2-VERSION", classification: "extension" },
  { ruleId: "OKF-0.2-PROVENANCE", classification: "recommended" },
  { ruleId: "OKF-0.2-GENERATED", classification: "recommended" },
  { ruleId: "OKF-0.2-VERIFICATION", classification: "recommended" },
  { ruleId: "OKF-0.2-LIFECYCLE", classification: "recommended" },
  { ruleId: "OKF-0.2-ATTESTED-COMPUTATION", classification: "normative" },
  { ruleId: "FOCOWIKI-0.2-RESERVED-OWNERSHIP", classification: "extension" },
  { ruleId: "FOCOWIKI-0.2-GENERATED-TARGET", classification: "extension" }
] as const);
