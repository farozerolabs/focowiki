const MARKDOWN_BODY = [
  "---",
  "type: reference",
  "title: Boundary fixture",
  "---",
  "",
  "# Boundary fixture",
  "",
  "This document validates generic Markdown lifecycle behavior.",
  ""
].join("\n");

const REJECTED_AT_REQUEST = "rejected_at_request";
const ACCEPTED = "accepted";
const ACCEPTED_THEN_FAILED = "accepted_then_failed";

export function buildInterleavedBoundaryCorpus() {
  const combiningTitle = "Re\u0301sume\u0301";
  const normalizedTitle = combiningTitle.normalize("NFC");
  const longSegments = Array.from(
    { length: 10 },
    (_, index) => `${String(index).padStart(2, "0")}-${"a".repeat(210)}`
  );

  return {
    kind: "focowiki-interleaved-lifecycle-boundary-corpus",
    files: [
      file("accepted-basic", "boundary/basic.md", MARKDOWN_BODY, ACCEPTED),
      file(
        "accepted-unicode-nfd",
        `boundary/${combiningTitle}.md`,
        MARKDOWN_BODY,
        ACCEPTED,
        { normalizedPath: `boundary/${normalizedTitle}.md` }
      ),
      file(
        "accepted-unicode-emoji",
        "boundary/emoji-\u{1F4DA}.md",
        MARKDOWN_BODY,
        ACCEPTED
      ),
      file(
        "accepted-full-width",
        "boundary/\uFF26\uFF55\uFF4C\uFF4C\uFF37\uFF49\uFF44\uFF54\uFF48.md",
        MARKDOWN_BODY,
        ACCEPTED
      ),
      file(
        "accepted-unusual-whitespace",
        "boundary/name\u2003space.md",
        MARKDOWN_BODY,
        ACCEPTED
      ),
      file(
        "accepted-max-segment",
        `boundary/${"s".repeat(237)}.md`,
        MARKDOWN_BODY,
        ACCEPTED
      ),
      file(
        "accepted-max-path",
        maxLengthMarkdownPath(),
        MARKDOWN_BODY,
        ACCEPTED
      ),
      file(
        "accepted-mixed-line-endings",
        "boundary/mixed-lines.md",
        MARKDOWN_BODY.replaceAll("\n", "\r\n").replace("\r\n\r\n", "\n\r\n"),
        ACCEPTED
      ),
      file("accepted-empty", "boundary/empty.md", "", ACCEPTED),
      file(
        "malformed-frontmatter",
        "boundary/malformed-frontmatter.md",
        "---\ntype: [unterminated\n---\n\n# Invalid frontmatter\n",
        ACCEPTED_THEN_FAILED
      ),
      file(
        "malformed-markdown",
        "boundary/malformed-markdown.md",
        `${MARKDOWN_BODY}\n[unfinished link](\n`,
        ACCEPTED
      ),
      file(
        "rejected-leading-whitespace",
        " boundary/leading-space.md",
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-absolute-path",
        "/boundary/absolute.md",
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-overlong-path",
        `${longSegments.join("/")}/document.md`,
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-overlong-segment",
        `boundary/${"b".repeat(241)}.md`,
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-traversal",
        "../boundary/traversal.md",
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-encoded-traversal",
        "%252e%252e/boundary/traversal.md",
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-encoded-separator",
        "boundary%252fescape.md",
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-backslash",
        "boundary\\backslash.md",
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-control-character",
        `boundary/control${String.fromCharCode(0)}.md`,
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-bidirectional-control",
        "boundary/report\u202Efdp.md",
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-dot-segment",
        "boundary/./dot.md",
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-unsupported-extension",
        "boundary/document.txt",
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      ),
      file(
        "rejected-reserved-name",
        "boundary/index.md",
        MARKDOWN_BODY,
        REJECTED_AT_REQUEST
      )
    ],
    duplicateSets: [
      {
        id: "duplicate-normalized-path",
        expected: REJECTED_AT_REQUEST,
        files: [
          file(
            "duplicate-normalized-path-nfd",
            `boundary/${combiningTitle}.md`,
            MARKDOWN_BODY,
            ACCEPTED
          ),
          file(
            "duplicate-normalized-path-nfc",
            `boundary/${normalizedTitle}.md`,
            MARKDOWN_BODY,
            ACCEPTED
          )
        ]
      },
      {
        id: "duplicate-case-folded-path",
        expected: REJECTED_AT_REQUEST,
        files: [
          file("duplicate-case-upper", "boundary/Case.md", MARKDOWN_BODY, ACCEPTED),
          file("duplicate-case-lower", "boundary/case.md", MARKDOWN_BODY, ACCEPTED)
        ]
      }
    ],
    protocolCases: [
      protocol("invalid-knowledge-base-id", "identifier", REJECTED_AT_REQUEST),
      protocol("cross-knowledge-base-file-id", "identifier", REJECTED_AT_REQUEST),
      protocol("malformed-cursor", "cursor", REJECTED_AT_REQUEST),
      protocol("cross-context-cursor", "cursor", REJECTED_AT_REQUEST),
      protocol("stale-resource-revision", "revision", REJECTED_AT_REQUEST),
      protocol("reused-operation-id", "operation", REJECTED_AT_REQUEST),
      protocol("invalid-idempotency-key", "idempotency", REJECTED_AT_REQUEST),
      protocol("unsupported-method", "http_method", REJECTED_AT_REQUEST),
      protocol("unsupported-media-type", "content_type", REJECTED_AT_REQUEST),
      protocol("invalid-utf8-transport", "transport_encoding", REJECTED_AT_REQUEST),
      protocol("missing-authorization", "authorization", REJECTED_AT_REQUEST),
      protocol("request-body-at-limit", "request_body", ACCEPTED),
      protocol("request-body-over-limit", "request_body", REJECTED_AT_REQUEST),
      protocol("page-size-at-limit", "pagination", ACCEPTED),
      protocol("page-size-over-limit", "pagination", REJECTED_AT_REQUEST),
      protocol("concurrency-at-limit", "runtime_setting", ACCEPTED),
      protocol("concurrency-over-limit", "runtime_setting", REJECTED_AT_REQUEST)
    ]
  };
}

export function summarizeInterleavedBoundaryCorpus(corpus) {
  const fileExpectations = countBy(corpus.files, (item) => item.expected);
  const protocolExpectations = countBy(
    corpus.protocolCases,
    (item) => item.expected
  );

  return {
    kind: corpus.kind,
    fileCount: corpus.files.length,
    duplicateSetCount: corpus.duplicateSets.length,
    protocolCaseCount: corpus.protocolCases.length,
    fileExpectations,
    protocolExpectations,
    caseIds: [
      ...corpus.files.map((item) => item.id),
      ...corpus.duplicateSets.map((item) => item.id),
      ...corpus.protocolCases.map((item) => item.id)
    ]
  };
}

export function assertInterleavedBoundaryCoverage(corpus, results) {
  const expectedIds = summarizeInterleavedBoundaryCorpus(corpus).caseIds;
  const expectedSet = new Set(expectedIds);
  const counts = new Map();

  for (const result of results) {
    counts.set(result.id, (counts.get(result.id) ?? 0) + 1);
  }

  const missing = expectedIds.filter((id) => !counts.has(id));
  const unexpected = [...counts.keys()].filter((id) => !expectedSet.has(id));
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);

  if (missing.length > 0) {
    throw new Error(`Missing boundary results: ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    throw new Error(`Unexpected boundary results: ${unexpected.join(", ")}`);
  }
  if (duplicates.length > 0) {
    throw new Error(`Duplicate boundary results: ${duplicates.join(", ")}`);
  }

  return {
    expected: expectedIds.length,
    executed: results.length,
    missing,
    unexpected,
    duplicates
  };
}

function file(id, relativePath, body, expected, extra = {}) {
  return {
    id,
    relativePath,
    contentType: "text/markdown; charset=utf-8",
    body,
    expected,
    ...extra
  };
}

function protocol(id, surface, expected) {
  return { id, surface, expected };
}

function maxLengthMarkdownPath() {
  const fileName = "document.md";
  const segments = [];
  let remaining = 2_048 - fileName.length;

  while (remaining > 0) {
    const segmentLength = Math.min(240, remaining - 1);
    segments.push("p".repeat(segmentLength));
    remaining -= segmentLength + 1;
  }

  return [...segments, fileName].join("/");
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
