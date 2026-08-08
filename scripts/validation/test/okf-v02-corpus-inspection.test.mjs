import assert from "node:assert/strict";
import test from "node:test";

import {
  findUnexpectedOkfV02RejectedGeneratedPaths,
  inspectOkfV02CorpusBaseline,
  inspectOkfV02RepresentativePages,
  parseOkfV02ValidationMarkdown
} from "../lib/okf-v02-corpus-inspection.mjs";

test("OKF 0.2 validation Markdown parsing preserves safe metadata and body", () => {
  assert.deepEqual(parseOkfV02ValidationMarkdown(`---
title: 示例
custom:
  enabled: true
---
# 示例

正文
`), {
    metadata: { title: "示例", custom: { enabled: true } },
    body: "# 示例\n\n正文"
  });
});

test("OKF 0.2 representative page inspection reads YAML values instead of formatting", () => {
  assert.deepEqual(inspectOkfV02RepresentativePages({
    valid: "---\nstatus: \"stable\"\n---\n# Valid",
    malformed: "---\nstatus:\n  - \"stable\"\n---\n# Malformed",
    incomplete: "---\ntype: \"Attested Computation\"\nexecutor: 42\n---\n# Incomplete"
  }), {
    valid: true,
    malformed: true,
    incompleteAttestedComputation: true
  });
});

test("OKF 0.2 rejected-path inspection allows Markdown references and rejects exact assets", () => {
  assert.deepEqual(findUnexpectedOkfV02RejectedGeneratedPaths({
    generatedPaths: [
      "pages/official/references/source.md",
      "pages/official/attesters/check.py"
    ],
    rejectedNonMarkdownPaths: ["attesters/check.py"]
  }), ["pages/official/attesters/check.py"]);
});

test("OKF 0.2 baseline inspection compares every official and legacy page", async () => {
  const samples = [
    fixture("official/concepts/guide.md", `---
okf_version: "0.2"
type: Guide
title: Guide
sources:
  - resource: https://example.com/source
generated:
  by: human:author
  at: "2026-08-08T00:00:00Z"
verified:
  - by: human:reviewer
    at: "2026-08-08T01:00:00Z"
---
# Guide

Evidence [source](../references/source.md).
`),
    fixture("legacy/legal.md", `---
title: 法律文档
timestamp: "2025-01-02"
legacy_owner: team
---
# 法律文档

中文内容。

# Citations

[1] [来源](https://example.com/legacy)
`)
  ];
  const generated = new Map(samples.map((sample) => [
    `pages/${sample.relativePath}`,
    sample.bytes.toString("utf8")
  ]));
  const sources = samples.map((sample, index) => ({
    relativePath: sample.relativePath,
    sourceFileId: `source-${index}`,
    generatedPath: `pages/${sample.relativePath}`
  }));

  const result = await inspectOkfV02CorpusBaseline({
    samples,
    sourceFiles: sources,
    readSourceContent: async (file) => samples.find(
      (sample) => sample.relativePath === file.relativePath
    ).bytes.toString("utf8"),
    readGeneratedContent: async (generatedPath) => generated.get(generatedPath),
    readRootContent: async () => "---\nokf_version: '0.2'\n---\n# Knowledge base"
  });

  assert.deepEqual(result, {
    totalCompared: 2,
    officialCompared: 1,
    legacyCompared: 1,
    officialWithSources: 1,
    officialWithGenerated: 1,
    officialWithVerified: 1,
    officialAttestedComputations: 0,
    legacyWithTimestamp: 1,
    legacyWithUnknownMetadata: 1,
    legacyWithChineseContent: 1,
    legacyWithCitations: 1,
    fabricatedProvenanceCount: 0
  });
});

test("OKF 0.2 baseline inspection rejects generated metadata drift", async () => {
  const sample = fixture("official/guide.md", "---\ntitle: Original\n---\n# Original\n");
  await assert.rejects(() => inspectOkfV02CorpusBaseline({
    samples: [sample],
    sourceFiles: [{
      relativePath: sample.relativePath,
      sourceFileId: "source-a",
      generatedPath: `pages/${sample.relativePath}`
    }],
    readSourceContent: async () => sample.bytes.toString("utf8"),
    readGeneratedContent: async () => "---\ntitle: Changed\n---\n# Original\n",
    readRootContent: async () => "---\nokf_version: '0.2'\n---\n# Root"
  }), /frontmatter/u);
});

test("OKF 0.2 baseline inspection allows the documented generated Related heading cleanup", async () => {
  const sample = fixture(
    "legacy/guide.md",
    "---\ntitle: Guide\n---\n# Guide\n\nBody.\n\n## Related\n\n- [Related guide](related.md)\n\n# Citations\n\n[1] Source\n"
  );
  const result = await inspectOkfV02CorpusBaseline({
    samples: [sample],
    sourceFiles: [{
      relativePath: sample.relativePath,
      sourceFileId: "source-a",
      generatedPath: "pages/legacy/guide.md"
    }],
    readSourceContent: async () => sample.bytes.toString("utf8"),
    readGeneratedContent: async () =>
      "---\ntitle: Guide\n---\n# Guide\n\nBody.\n\n# Citations\n\n[1] Source\n",
    readRootContent: async () => "---\nokf_version: '0.2'\n---\n# Root"
  });
  assert.equal(result.legacyCompared, 1);
  assert.equal(result.legacyWithCitations, 1);
});

test("OKF 0.2 baseline inspection compares equivalent canonical date-time values", async () => {
  const sample = fixture(
    "official/computation.md",
    "---\ntitle: Computation\ngenerated:\n  by: human:author\n  at: '2026-06-30T14:00:00Z'\n---\n# Computation\n"
  );
  const result = await inspectOkfV02CorpusBaseline({
    samples: [sample],
    sourceFiles: [{
      relativePath: sample.relativePath,
      sourceFileId: "source-a",
      generatedPath: "pages/official/computation.md"
    }],
    readSourceContent: async () => sample.bytes.toString("utf8"),
    readGeneratedContent: async () =>
      "---\ntitle: Computation\ngenerated:\n  by: human:author\n  at: '2026-06-30T14:00:00.000Z'\n---\n# Computation\n",
    readRootContent: async () => "---\nokf_version: '0.2'\n---\n# Root"
  });
  assert.equal(result.officialWithGenerated, 1);
});

test("OKF 0.2 baseline inspection uses project normalization for generated metadata", async () => {
  const sample = fixture(
    "official/guide.md",
    "---\ntitle: Guide\nverified:\n  - by: human:reviewer\n    at: '2026-08-08T00:00:00Z'\n---\n# Guide\n"
  );
  const result = await inspectOkfV02CorpusBaseline({
    samples: [sample],
    sourceFiles: [{
      relativePath: sample.relativePath,
      sourceFileId: "source-a",
      generatedPath: "pages/official/guide.md"
    }],
    readSourceContent: async () => sample.bytes.toString("utf8"),
    readGeneratedContent: async () =>
      "---\ntitle: Guide\nverified:\n  - {\"at\":\"2026-08-08T00:00:00.000Z\",\"by\":\"human:reviewer\"}\n---\n# Guide\n",
    readRootContent: async () => "---\nokf_version: '0.2'\n---\n# Root",
    normalizeSourceMetadata: (metadata) => ({
      ...metadata,
      verified: [{ at: "2026-08-08T00:00:00.000Z", by: "human:reviewer" }]
    })
  });
  assert.equal(result.officialWithVerified, 1);
});

test("OKF 0.2 baseline inspection allows canonicalizing the first body heading", async () => {
  const sample = fixture(
    "official/dataset.md",
    "---\ntitle: Dataset\n---\nIntroductory body.\n\n# Schema\n\nSchema details.\n"
  );
  const result = await inspectOkfV02CorpusBaseline({
    samples: [sample],
    sourceFiles: [{
      relativePath: sample.relativePath,
      sourceFileId: "source-a",
      generatedPath: "pages/official/dataset.md"
    }],
    readSourceContent: async () => sample.bytes.toString("utf8"),
    readGeneratedContent: async () =>
      "---\ntitle: Dataset\n---\n# Dataset\n\nIntroductory body.\n\nSchema details.\n",
    readRootContent: async () => "---\nokf_version: '0.2'\n---\n# Root"
  });
  assert.equal(result.officialCompared, 1);
});

function fixture(relativePath, content) {
  return { relativePath, bytes: Buffer.from(content) };
}
