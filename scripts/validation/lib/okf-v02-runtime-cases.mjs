const BODY_PREFIX = "# OKF v0.2 E2E target\n\nokfv02e2etoken";

export function buildOkfV02ValidMarkdown(label = "valid") {
  return `---
okf_version: '0.2'
type: Guide
title: OKF v0.2 E2E target
sources:
  - id: source-e2e
    resource: https://example.com/evidence
generated:
  by: publisher:focowiki-e2e
  at: '2026-08-07T00:00:00Z'
verified:
  - by: human:e2e-reviewer
    at: '2026-08-07T01:00:00Z'
status: stable
stale_after: '2027-12-31'
---
${BODY_PREFIX} ${label}
`;
}

export const OKF_V02_RUNTIME_VARIANTS = Object.freeze([
  variant(
    "missing-standard-fields",
    `${BODY_PREFIX} missing-standard-fields\n`,
    {},
    { effectiveStatus: "stable", trustTier: "unverified", isStale: null, sourceCount: 0 }
  ),
  variant(
    "status-wrong-type",
    frontmatter("status-wrong-type", "status:\n  - stable"),
    { status: ["stable"] },
    { effectiveStatus: null },
    "okfStatus"
  ),
  variant(
    "status-unsupported-value",
    frontmatter("status-unsupported-value", "status: experimental"),
    { status: "experimental" },
    { effectiveStatus: null },
    "okfStatus"
  ),
  variant(
    "stale-after-wrong-format",
    frontmatter("stale-after-wrong-format", "stale_after: next quarter"),
    { stale_after: "next quarter" },
    { staleAfter: null, isStale: null },
    "okfFreshness"
  ),
  variant(
    "generated-wrong-type",
    frontmatter("generated-wrong-type", "generated:\n  - invalid"),
    { generated: ["invalid"] },
    { generatedAt: null, generatedAtSource: null }
  ),
  variant(
    "generated-date-only-datetime",
    frontmatter(
      "generated-date-only-datetime",
      "generated:\n  by: publisher:focowiki-e2e\n  at: '2026-08-07'"
    ),
    { generated: { by: "publisher:focowiki-e2e", at: "2026-08-07" } },
    { generatedAt: null, generatedAtSource: null }
  ),
  variant(
    "verified-wrong-shape",
    frontmatter("verified-wrong-shape", "verified:\n  - by: 42\n    at: today"),
    { verified: [{ by: 42, at: "today" }] },
    { trustTier: null, latestVerifiedAt: null },
    "okfTrustTier"
  ),
  variant(
    "sources-wrong-shape",
    frontmatter("sources-wrong-shape", "sources:\n  resource: evidence.md"),
    { sources: { resource: "evidence.md" } },
    { sourceCount: null }
  ),
  variant(
    "runtime-wrong-type",
    frontmatter("runtime-wrong-type", "type: Attested Computation\nruntime:\n  - python", false),
    { runtime: ["python"] },
    {}
  ),
  variant(
    "parameters-wrong-type",
    frontmatter("parameters-wrong-type", "type: Attested Computation\nruntime: python\nparameters: unknown", false),
    { parameters: "unknown" },
    {}
  ),
  variant(
    "executor-wrong-type",
    frontmatter("executor-wrong-type", "type: Attested Computation\nruntime: python\nexecutor: 42", false),
    { executor: 42 },
    {}
  ),
  variant(
    "attester-wrong-type",
    frontmatter("attester-wrong-type", "type: Attested Computation\nruntime: python\nattester: false", false),
    { attester: false },
    {}
  )
]);

function variant(id, markdown, expectedRaw, expectedSignals, excludedFilter = null) {
  return Object.freeze({ id, markdown, expectedRaw, expectedSignals, excludedFilter });
}

function frontmatter(id, fields, includeGuideType = true) {
  return `---
${includeGuideType ? "type: Guide\n" : ""}title: OKF v0.2 E2E target
${fields}
---
${BODY_PREFIX} ${id}
`;
}
