import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

const okfRequire = createRequire(path.resolve("packages/okf/package.json"));
const { parse: parseYaml } = okfRequire("yaml");

const KNOWN_OKF_FIELDS = new Set([
  "okf_version",
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "sources",
  "usage_window",
  "generated",
  "verified",
  "status",
  "stale_after",
  "timestamp",
  "version",
  "runtime",
  "parameters",
  "computation",
  "executor",
  "attester"
]);

export async function inspectOkfV02CorpusBaseline(input) {
  assert(Array.isArray(input.samples), "OKF 0.2 baseline samples are required.");
  assert(Array.isArray(input.sourceFiles), "OKF 0.2 baseline source files are required.");
  const sourceByPath = new Map(input.sourceFiles.map((file) => [file.relativePath, file]));
  assert.equal(sourceByPath.size, input.samples.length, "OKF 0.2 baseline source count changed.");

  const result = {
    totalCompared: 0,
    officialCompared: 0,
    legacyCompared: 0,
    officialWithSources: 0,
    officialWithGenerated: 0,
    officialWithVerified: 0,
    officialAttestedComputations: 0,
    legacyWithTimestamp: 0,
    legacyWithUnknownMetadata: 0,
    legacyWithChineseContent: 0,
    legacyWithCitations: 0,
    fabricatedProvenanceCount: 0
  };

  for (const sample of input.samples) {
    const sourceFile = sourceByPath.get(sample.relativePath);
    assert(sourceFile?.sourceFileId, `Baseline source identity is missing for ${sample.relativePath}.`);
    assert(sourceFile.generatedPath, `Baseline generated path is missing for ${sample.relativePath}.`);
    const expectedSource = Buffer.from(sample.bytes).toString("utf8");
    const actualSource = await input.readSourceContent(sourceFile);
    assert.equal(actualSource, expectedSource, `Source bytes changed for ${sample.relativePath}.`);
    const generatedContent = await input.readGeneratedContent(sourceFile.generatedPath);
    assert.equal(typeof generatedContent, "string", "Generated baseline content is unavailable.");
    const source = parseOkfV02ValidationMarkdown(expectedSource);
    const generated = parseOkfV02ValidationMarkdown(generatedContent);
    const expectedMetadata = input.normalizeSourceMetadata
      ? input.normalizeSourceMetadata(source.metadata, source.body)
      : source.metadata;
    assert(
      isDeepStrictEqual(
        normalizeEquivalentDateTimes(generated.metadata),
        normalizeEquivalentDateTimes(expectedMetadata)
      ),
      `Generated frontmatter changed for ${sample.relativePath}.`
    );
    assertBodyPreserved(source.body, generated.body, sample.relativePath);

    const official = sample.relativePath.startsWith("official/");
    const legacy = sample.relativePath.startsWith("legacy/");
    assert(official || legacy, "OKF 0.2 baseline path has no compatibility class.");
    result.totalCompared += 1;
    if (official) {
      result.officialCompared += 1;
      if (hasMeaningfulValue(source.metadata.sources)) result.officialWithSources += 1;
      if (hasMeaningfulValue(source.metadata.generated)) result.officialWithGenerated += 1;
      if (hasMeaningfulValue(source.metadata.verified)) result.officialWithVerified += 1;
      if (String(source.metadata.type).toLocaleLowerCase("en-US") === "attested computation") {
        result.officialAttestedComputations += 1;
      }
    }
    if (legacy) {
      result.legacyCompared += 1;
      if (hasMeaningfulValue(source.metadata.timestamp)) result.legacyWithTimestamp += 1;
      if (Object.keys(source.metadata).some((key) => !KNOWN_OKF_FIELDS.has(key))) {
        result.legacyWithUnknownMetadata += 1;
      }
      if (/\p{Script=Han}/u.test(source.body)) result.legacyWithChineseContent += 1;
      if (hasSourceAuthoredCitation(source.body)) result.legacyWithCitations += 1;
    }
  }

  const root = await input.readRootContent();
  assert(/okf_version:\s*['"]?0\.2/iu.test(root), "Generated baseline root is not OKF 0.2.");
  const rootMetadata = parseOkfV02ValidationMarkdown(root).metadata;
  assert.equal(rootMetadata.sources, undefined, "Generated root fabricated source provenance.");
  assert.equal(result.totalCompared, input.samples.length);
  return Object.freeze(result);
}

export function parseOkfV02ValidationMarkdown(content) {
  assert.equal(typeof content, "string", "Validation Markdown content must be text.");
  const normalized = content.replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return { metadata: {}, body: normalized.trim() };
  }
  const lines = normalized.split(/\r?\n/u);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  assert(end > 0, "Validation Markdown frontmatter is unterminated.");
  const parsed = parseYaml(lines.slice(1, end).join("\n"), { schema: "core" }) ?? {};
  assert(
    parsed && typeof parsed === "object" && !Array.isArray(parsed),
    "Validation Markdown frontmatter must be a record."
  );
  return {
    metadata: parsed,
    body: lines.slice(end + 1).join("\n").trim()
  };
}

export function inspectOkfV02RepresentativePages(input) {
  const valid = parseOkfV02ValidationMarkdown(input.valid).metadata;
  const malformed = parseOkfV02ValidationMarkdown(input.malformed).metadata;
  const incomplete = parseOkfV02ValidationMarkdown(input.incomplete).metadata;
  assert.equal(valid.status, "stable", "Valid OKF page lost its lifecycle metadata.");
  assert.deepEqual(malformed.status, ["stable"],
    "Malformed-but-safe OKF page is no longer readable.");
  assert.equal(incomplete.type, "Attested Computation",
    "Incomplete Attested Computation type is unavailable.");
  assert.equal(incomplete.executor, 42,
    "Incomplete Attested Computation metadata is unavailable.");
  return Object.freeze({
    valid: true,
    malformed: true,
    incompleteAttestedComputation: true
  });
}

export function findUnexpectedOkfV02RejectedGeneratedPaths(input) {
  const generated = new Set(input.generatedPaths);
  return input.rejectedNonMarkdownPaths
    .map((relativePath) => `pages/official/${relativePath}`)
    .filter((logicalPath) => generated.has(logicalPath));
}

function assertBodyPreserved(sourceBody, generatedBody, relativePath) {
  const generatedComparable = comparableBody(generatedBody);
  const sourceLines = sourceBody.split(/\r?\n/u);
  let inGeneratedRelatedAppendix = false;
  let firstSourceH1Seen = false;
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index].trim();
    if (/^#{1,6}\s+Related\s*$/iu.test(line)) {
      inGeneratedRelatedAppendix = true;
      continue;
    }
    if (inGeneratedRelatedAppendix && /^#{1,6}\s/u.test(line)) {
      inGeneratedRelatedAppendix = false;
    }
    if (inGeneratedRelatedAppendix) continue;
    if (/^#\s/u.test(line) && !firstSourceH1Seen) {
      firstSourceH1Seen = true;
      continue;
    }
    if (
      !line
    ) continue;
    const comparable = comparableLine(line);
    if (!comparable) continue;
    assert(
      generatedComparable.includes(comparable),
      `Generated body omitted source content for ${relativePath}`
        + ` (line ${index + 1}, ${lineKind(line)}).`
    );
  }
}

function lineKind(line) {
  if (/^#{1,6}\s/u.test(line)) return "heading";
  if (/^\[[^\]]+\]:/u.test(line)) return "footnote";
  if (/\]\(/u.test(line)) return "link";
  return "text";
}

function comparableBody(body) {
  return body.split(/\r?\n/u).map((line) => comparableLine(line.trim())).join("\n");
}

function comparableLine(line) {
  return line
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "[$1]")
    .replace(/\s+/gu, " ")
    .trim();
}

function hasMeaningfulValue(value) {
  return value !== undefined && value !== null && value !== ""
    && (!Array.isArray(value) || value.length > 0);
}

function hasSourceAuthoredCitation(body) {
  return /(?:^|\n)#\s+Citations\b|(?:^|\n)\[\d+\]\s|(?:^|\n)\[\^[^\]]+\]:|https?:\/\//iu.test(body);
}

function normalizeEquivalentDateTimes(value) {
  if (Array.isArray(value)) return value.map(normalizeEquivalentDateTimes);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      normalizeEquivalentDateTimes(item)
    ]));
  }
  if (
    typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
  ) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return value;
}
