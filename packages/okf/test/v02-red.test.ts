import { describe, expect, it } from "vitest";
import * as okf from "../src/index.js";
import {
  parseUploadedMarkdownSource,
  prepareGeneratedMarkdownBody,
  validateOkfBundle
} from "../src/index.js";

type Analysis = {
  metadata: Record<string, unknown>;
  signals: {
    effectiveStatus: "draft" | "stable" | "deprecated" | null;
    trustTier: "unverified" | "machine-confirmed" | "human-reviewed" | null;
    isStale: boolean | null;
    staleAfter: string | null;
    generatedAt: string | null;
    generatedAtSource: "generated" | "legacy_timestamp" | null;
    latestVerifiedAt: string | null;
    sourceCount: number | null;
  };
  diagnostics: Array<{
    ruleId: string;
    classification: string;
    disposition: "advisory" | "blocking";
    path: string;
  }>;
  attestedComputation: {
    complete: boolean;
    runtime: string | null;
    parameters: Array<{ name: string; type: string; required: boolean }>;
  } | null;
};

type AnalyzeOptions = {
  ownership?: "source" | "focowiki";
  today?: string;
  markdownBody?: string;
  candidatePaths?: readonly string[];
};

type AnalyzeOkfMetadata = (
  metadata: Record<string, unknown>,
  options?: AnalyzeOptions
) => Analysis;

type BuildPublicationMetadata = (input: {
  ownership: "source" | "focowiki";
  metadata: Record<string, unknown>;
  artifactKind?: "concept" | "bundle_root";
  changedAt?: string;
}) => Record<string, unknown>;

function analyze(
  metadata: Record<string, unknown>,
  options: AnalyzeOptions = {}
): Analysis {
  const implementation = (okf as unknown as {
    analyzeOkfMetadata?: AnalyzeOkfMetadata;
  }).analyzeOkfMetadata;
  expect(implementation, "packages/okf must export analyzeOkfMetadata").toBeTypeOf("function");
  return implementation!(metadata, options);
}

function buildPublicationMetadata(input: Parameters<BuildPublicationMetadata>[0]) {
  const implementation = (okf as unknown as {
    buildOkfPublicationMetadata?: BuildPublicationMetadata;
  }).buildOkfPublicationMetadata;
  expect(
    implementation,
    "packages/okf must export buildOkfPublicationMetadata"
  ).toBeTypeOf("function");
  return implementation!(input);
}

describe("OKF 0.2 compatibility", () => {
  it("accepts native 0.2, legacy 0.1, undeclared, and future bundle declarations", () => {
    for (const declaration of ["0.2", "0.1", "9.0"] as const) {
      expect(() => validateOkfBundle([{
        path: "index.md",
        content: `---\nokf_version: "${declaration}"\n---\n# Knowledge base`
      }])).not.toThrow();
    }
    expect(() => validateOkfBundle([{
      path: "index.md",
      content: "# Knowledge base"
    }])).not.toThrow();
  });

  it("records the pinned 0.2 audit source independently from legacy code", () => {
    const baseline = (okf as unknown as {
      OKF_V02_AUDIT_BASELINE: Record<string, unknown>;
      OKF_V02_RULE_AUDIT_BASELINE: readonly Record<string, unknown>[];
    });
    expect(baseline.OKF_V02_AUDIT_BASELINE).toMatchObject({
      version: "0.2",
      repositoryRevision: "930b65fc3f5619d5d0591f88c72ebae8b848d60d"
    });
    expect(baseline.OKF_V02_RULE_AUDIT_BASELINE.length).toBeGreaterThan(10);
  });

  it("keeps future declarations readable with an advisory and emits only 0.2", () => {
    const future = analyze({ okf_version: "9.0", type: "Guide" });
    expect(future.metadata.okf_version).toBe("9.0");
    expect(future.diagnostics).toContainEqual(expect.objectContaining({
      disposition: "advisory"
    }));

    expect(buildPublicationMetadata({
      ownership: "focowiki",
      metadata: { okf_version: "0.1", type: "Index" },
      artifactKind: "bundle_root",
      changedAt: "2026-08-07T10:00:00Z"
    }).okf_version).toBe("0.2");
  });
});

describe("OKF 0.2 scalar semantics", () => {
  it("preserves date-only fields and unknown YAML scalars as strings", () => {
    const parsed = parseUploadedMarkdownSource({
      fileName: "dates.md",
      content: [
        "---",
        "type: Guide",
        "stale_after: 2026-09-23",
        "generated:",
        "  by: process:publisher",
        "  at: 2026-08-07T10:30:00Z",
        "future_date: 2026-08-08",
        "---",
        "# Dates"
      ].join("\n")
    });

    expect(parsed.metadata.stale_after).toBe("2026-09-23");
    expect(parsed.metadata.future_date).toBe("2026-08-08");
    expect(parsed.metadata.generated).toEqual({
      by: "process:publisher",
      at: "2026-08-07T10:30:00Z"
    });
  });


  it("round-trips safe unknown nested date-like scalars without Date objects", () => {
    const parsed = parseUploadedMarkdownSource({
      fileName: "unknown.md",
      content: [
        "---",
        "type: Guide",
        "future:",
        "  nested:",
        "    released: 2026-08-08",
        "    observed: 2026-08-08T10:20:30Z",
        "---",
        "# Unknown"
      ].join("\n")
    });
    expect(parsed.metadata.future).toEqual({
      nested: {
        released: "2026-08-08",
        observed: "2026-08-08T10:20:30Z"
      }
    });
  });
});

describe("OKF 0.2 provenance and citations", () => {
  it("normalizes sources and shared usage windows without changing stable IDs", () => {
    const result = analyze({
      type: "Guide",
      sources: [{
        id: "policy-source",
        resource: "policies/source.md",
        title: "Source policy",
        usage_count: 12,
        last_modified: "2026-08-01"
      }],
      usage_window: { from: "2026-08-01", to: "2026-08-07" }
    }, {
      markdownBody: "A source-backed statement.[^policy-source]\n\n[^policy-source]: Source policy"
    });

    expect(result.signals.sourceCount).toBe(1);
    expect(result.metadata.sources).toEqual([expect.objectContaining({
      id: "policy-source",
      resource: "policies/source.md"
    })]);
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps user-authored source and footnote mismatches advisory", () => {
    const result = analyze({
      type: "Guide",
      sources: [{ id: "source-a", resource: "source.md" }]
    }, {
      ownership: "source",
      markdownBody: "Claim.[^missing]\n\n[^missing]: Missing source"
    });

    expect(result.signals.sourceCount).toBe(1);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ disposition: "advisory" })
    ]));
  });

  it("resolves shared and per-source usage windows without changing source IDs", () => {
    const result = analyze({
      type: "Guide",
      usage_window: { from: "2026-01-01", to: "2026-12-31" },
      sources: [
        { id: "shared", resource: "shared.md" },
        {
          id: "overridden",
          resource: "override.md",
          usage_window: { from: "2026-07-01", to: "2026-07-31" }
        }
      ]
    });
    expect(result.metadata.sources).toEqual([
      expect.objectContaining({
        id: "shared",
        usage_window: { from: "2026-01-01", to: "2026-12-31" }
      }),
      expect.objectContaining({
        id: "overridden",
        usage_window: { from: "2026-07-01", to: "2026-07-31" }
      })
    ]);
  });

  it("preserves a source-authored legacy citation appendix", () => {
    const prepared = prepareGeneratedMarkdownBody(
      "# Guide\n\nBody.\n\n# Citations\n\n[1] [Legacy](https://example.com/source)"
    );
    expect(prepared.trailingCitations).toContain("# Citations");
    expect(prepared.trailingCitations).toContain("[1] [Legacy]");
  });

  it("does not synthesize numbered citations from legacy resource metadata", () => {
    const published = buildPublicationMetadata({
      ownership: "source",
      metadata: {
        type: "Guide",
        resource: "https://example.com/legacy"
      }
    });
    expect(published).not.toHaveProperty("sources");
  });
});

describe("OKF 0.2 generated, verification, actor, and lifecycle signals", () => {
  it("derives human review and exact freshness from valid events", () => {
    const result = analyze({
      type: "Guide",
      generated: { by: "reference_agent/1.0", at: "2026-08-06T10:00:00Z" },
      verified: [
        { by: "process:nightly", at: "2026-08-06T11:00:00Z" },
        { by: "human:reviewer", at: "2026-08-07T12:00:00Z" }
      ],
      status: "stable",
      stale_after: "2026-08-07"
    }, { today: "2026-08-07" });

    expect(result.signals).toMatchObject({
      effectiveStatus: "stable",
      trustTier: "human-reviewed",
      isStale: true,
      staleAfter: "2026-08-07",
      generatedAt: "2026-08-06T10:00:00.000Z",
      generatedAtSource: "generated",
      latestVerifiedAt: "2026-08-07T12:00:00.000Z",
      sourceCount: 0
    });
  });

  it("normalizes a bare verification mapping and machine-only review", () => {
    const result = analyze({
      type: "Guide",
      verified: { by: "process:nightly", at: "2026-08-06T11:00:00Z" }
    });
    expect(result.metadata.verified).toEqual([
      { by: "process:nightly", at: "2026-08-06T11:00:00.000Z" }
    ]);
    expect(result.signals.trustTier).toBe("machine-confirmed");
  });

  it("classifies all three trust tiers and preserves unknown actors", () => {
    expect(analyze({ type: "Guide" }).signals.trustTier).toBe("unverified");
    expect(analyze({
      type: "Guide",
      verified: [{ by: "process:nightly", at: "2026-08-06T11:00:00Z" }]
    }).signals.trustTier).toBe("machine-confirmed");
    const human = analyze({
      type: "Guide",
      verified: [{ by: "human:reviewer", at: "2026-08-07T11:00:00Z" }],
      generated: { by: "vendor:unknown-agent", at: "2026-08-06T11:00:00Z" }
    });
    expect(human.signals.trustTier).toBe("human-reviewed");
    expect(human.metadata.generated).toMatchObject({ by: "vendor:unknown-agent" });
  });

  it("uses documented omitted defaults without inventing freshness", () => {
    const result = analyze({ type: "Guide" }, { today: "2026-08-07" });
    expect(result.signals).toMatchObject({
      effectiveStatus: "stable",
      trustTier: "unverified",
      isStale: null,
      staleAfter: null,
      sourceCount: 0
    });
  });
});

describe("OKF 0.2 Attested Computation", () => {
  it("builds a complete normalized file contract", () => {
    const result = analyze({
      type: "Attested Computation",
      title: "Revenue for fiscal year",
      description: "Recognized revenue for a fiscal year, per Finance's definition.",
      runtime: "bigquery",
      parameters: [{ name: "year", type: "integer", required: true }],
      executor: {
        resource: "references/skills/run-on-bq.md",
        receipt: ["job_id", "executed_sql", "result"]
      },
      attester: { resource: "references/attesters/revenue.py" }
    }, {
      candidatePaths: [
        "references/skills/run-on-bq.md",
        "references/attesters/revenue.py"
      ],
      markdownBody: [
        "# Computation",
        "",
        "```sql",
        "SELECT SUM(amount) FROM finance.recognized_revenue WHERE fiscal_year = @year",
        "```"
      ].join("\n")
    });

    expect(result.attestedComputation).toEqual(expect.objectContaining({
      complete: true,
      runtime: "bigquery",
      parameters: [{ name: "year", type: "integer", required: true }]
    }));
  });

  it("keeps incomplete user-authored contracts readable and advisory", () => {
    const result = analyze({
      type: "Attested Computation",
      parameters: [{ name: "year", required: "yes" }],
      executor: { resource: "references/missing.md" },
      attester: "invalid"
    }, { ownership: "source" });

    expect(result.attestedComputation).toMatchObject({
      complete: false,
      runtime: null
    });
    expect(result.metadata.attester).toBe("invalid");
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((item) => item.disposition === "advisory")).toBe(true);
  });

  it("supports inline computation and reports missing source assets without blocking", () => {
    const result = analyze({
      type: "Attested Computation",
      runtime: "python",
      parameters: [],
      executor: { resource: "references/missing-runner.md" },
      attester: { resource: "references/missing-attester.md" }
    }, {
      ownership: "source",
      candidatePaths: [],
      markdownBody: "# Computation\n\n```python\nreturn 42\n```"
    });
    expect(result.attestedComputation).toMatchObject({
      complete: false,
      runtime: "python"
    });
    expect(result.diagnostics.every((item) => item.disposition === "advisory")).toBe(true);
  });

  it("blocks incomplete Focowiki-owned generated computation targets", () => {
    const result = analyze({
      type: "Attested Computation",
      runtime: "python",
      parameters: [],
      computation: "generated/run.py",
      executor: { resource: "generated/executor.md" },
      attester: { resource: "generated/attester.md" }
    }, {
      ownership: "focowiki",
      candidatePaths: []
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      disposition: "blocking"
    }));
  });
});

describe("permissive user-authored metadata", () => {
  it("accepts missing frontmatter and irregular standard-field shapes", () => {
    expect(() => parseUploadedMarkdownSource({
      fileName: "plain.md",
      content: "# Plain Markdown"
    })).not.toThrow();

    const parsed = parseUploadedMarkdownSource({
      fileName: "irregular.md",
      content: [
        "---",
        "type: [Guide]",
        "sources: invalid",
        "usage_window: [invalid]",
        "generated: 42",
        "verified: invalid",
        "status: archived",
        "stale_after: tomorrow",
        "runtime: [python]",
        "parameters: invalid",
        "executor: 42",
        "attester: false",
        "---",
        "# Irregular"
      ].join("\n")
    });
    expect(parsed.metadata).toMatchObject({
      type: ["Guide"],
      sources: "invalid",
      usage_window: ["invalid"],
      generated: 42,
      verified: "invalid",
      status: "archived",
      stale_after: "tomorrow",
      runtime: ["python"],
      parameters: "invalid",
      executor: 42,
      attester: false
    });

    const result = analyze(parsed.metadata, { ownership: "source" });
    expect(result.signals).toMatchObject({
      effectiveStatus: null,
      trustTier: null,
      isStale: null,
      generatedAt: null,
      sourceCount: null
    });
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((item) => item.disposition === "advisory")).toBe(true);
  });
});
