import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const requireFromOkfPackage = createRequire(
  pathToFileURL(path.resolve("packages/okf/package.json"))
);
const matter = requireFromOkfPackage("gray-matter");

export const CONTENT_SAMPLE_COUNT_ENV = "FOCOWIKI_VALIDATION_CONTENT_SAMPLE_COUNT";

const GENERIC_TOKENS = new Set([
  "规则",
  "管理",
  "实施",
  "有效",
  "修改",
  "修订",
  "发布",
  "施行",
  "文档",
  "文件",
  "资料",
  "内容",
  "信息",
  "页面",
  "来源",
  "标题",
  "索引",
  "相关",
  "引用",
  "参考",
  "当前",
  "部分",
  "章节"
]);

export function readContentQualitySampleLimit(env = process.env) {
  const configured = env[CONTENT_SAMPLE_COUNT_ENV]?.trim();

  if (!configured) {
    return 25;
  }

  const parsed = Number(configured);

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new Error(`${CONTENT_SAMPLE_COUNT_ENV} must be an integer between 1 and 200.`);
  }

  return parsed;
}

export function validateGeneratedContentQuality({
  samples,
  bodies,
  indexes,
  modelAssistance,
  semanticSampleLimit = 25
}) {
  const manifestFiles = asArray(indexes?.manifest?.files);
  const searchItems = asArray(indexes?.search?.items);
  const links = asArray(indexes?.links?.links);
  const manifestByPath = new Map(manifestFiles.map((file) => [file.path, file]));
  const searchByPath = new Map(searchItems.map((item) => [item.path, item]));
  const summary = {
    sampleCount: samples.length,
    structuralSamples: 0,
    semanticSamples: 0,
    sourceSupportedPages: 0,
    modelCheckedPages: 0,
    graphLinks: 0,
    questionableGraphLinks: 0,
    pagesWithGraphLinks: 0,
    warnings: []
  };

  for (const sample of samples) {
    const pagePath = pagePathForSample(sample);
    const manifestEntry = manifestByPath.get(pagePath);
    const searchItem = searchByPath.get(pagePath);
    const pageBody = bodies.get(pagePath);

    if (!manifestEntry) {
      throw new Error(`Content validation missing manifest entry for ${pagePath}.`);
    }

    if (!searchItem) {
      throw new Error(`Content validation missing search entry for ${pagePath}.`);
    }

    if (typeof pageBody !== "string" || !pageBody.trim()) {
      throw new Error(`Content validation missing generated page body for ${pagePath}.`);
    }

    assertPageMetadataMatchesSample(pagePath, pageBody, sample, manifestEntry, searchItem);
    summary.structuralSamples += 1;
  }

  const semanticSamples = samples.slice(0, Math.min(samples.length, semanticSampleLimit));

  for (const sample of semanticSamples) {
    const pagePath = pagePathForSample(sample);
    const pageBody = bodies.get(pagePath);
    const searchItem = searchByPath.get(pagePath);
    const source = readSourceMarkdown(sample);

    assertGeneratedPagePreservesSourceContent(pagePath, pageBody, source);
    summary.semanticSamples += 1;
    summary.sourceSupportedPages += 1;

    if (modelAssistance?.enabled) {
      validateModelBackedFields(pagePath, pageBody, searchItem);
      summary.modelCheckedPages += 1;
    }
  }

  const graphSummary = validateGraphRelationships({
    links,
    searchByPath,
    samplePaths: new Set(samples.map(pagePathForSample)),
    semanticPaths: new Set(semanticSamples.map(pagePathForSample))
  });

  summary.graphLinks = graphSummary.graphLinks;
  summary.questionableGraphLinks = graphSummary.questionableGraphLinks;
  summary.pagesWithGraphLinks = graphSummary.pagesWithGraphLinks;
  summary.warnings.push(...graphSummary.warnings);

  return summary;
}

function assertPageMetadataMatchesSample(pagePath, pageBody, sample, manifestEntry, searchItem) {
  const parsed = matter(pageBody);
  const pageTitle = readString(parsed.data?.title);
  const pageType = readString(parsed.data?.type);

  if (!pageBody.startsWith("---\n") || !pageTitle || !pageType) {
    throw new Error(`Generated page is missing required frontmatter for ${pagePath}.`);
  }

  if (pageTitle !== sample.title) {
    throw new Error(`Generated page title does not match source title for ${pagePath}.`);
  }

  if (sample.type && pageType !== sample.type) {
    throw new Error(`Generated page type does not match source type for ${pagePath}.`);
  }

  if (manifestEntry.title !== sample.title || searchItem.title !== sample.title) {
    throw new Error(`Index title does not match generated page title for ${pagePath}.`);
  }

  if (manifestEntry.metadata?.title !== sample.title || searchItem.metadata?.title !== sample.title) {
    throw new Error(`Index metadata title does not match generated page title for ${pagePath}.`);
  }

  if (sample.type && (manifestEntry.metadata?.type !== sample.type || searchItem.metadata?.type !== sample.type)) {
    throw new Error(`Index metadata type does not match generated page type for ${pagePath}.`);
  }
}

function assertGeneratedPagePreservesSourceContent(pagePath, generatedPage, source) {
  const generated = normalizeText(matter(generatedPage).content);
  const sourceBody = normalizeText(source.body);
  const title = source.title ? normalizeText(source.title) : "";
  const snippets = sourceBodySnippets(sourceBody);

  if (title && !generated.includes(title)) {
    throw new Error(`Generated page body does not include the source title for ${pagePath}.`);
  }

  if (snippets.length === 0) {
    return;
  }

  const matched = snippets.filter((snippet) => generated.includes(snippet));

  if (matched.length === 0) {
    throw new Error(`Generated page body does not preserve source body evidence for ${pagePath}.`);
  }
}

function validateModelBackedFields(pagePath, pageBody, searchItem) {
  const parsed = matter(pageBody);
  const description = readString(parsed.data?.description) || readString(searchItem?.description);
  const tags = asStringArray(parsed.data?.tags).length
    ? asStringArray(parsed.data?.tags)
    : asStringArray(searchItem?.tags);
  const keywords = asStringArray(searchItem?.keywords);

  if (!description && tags.length === 0 && keywords.length === 0) {
    throw new Error(`Model-enabled validation found no description, tags, or keywords for ${pagePath}.`);
  }

  if (description && normalizeText(description).length < 8) {
    throw new Error(`Model-enabled validation found an unusable description for ${pagePath}.`);
  }
}

function validateGraphRelationships({ links, searchByPath, samplePaths, semanticPaths }) {
  const graphLinks = links.filter(
    (link) =>
      typeof link.from === "string" &&
      typeof link.to === "string" &&
      link.from.startsWith("pages/") &&
      link.to.startsWith("pages/") &&
      link.from !== link.to
  );
  const pagesWithGraphLinks = new Set(graphLinks.map((link) => link.from));
  const questionable = [];

  for (const link of graphLinks) {
    if (!samplePaths.has(link.from) || !samplePaths.has(link.to)) {
      continue;
    }

    const from = searchByPath.get(link.from);
    const to = searchByPath.get(link.to);

    if (!from || !to) {
      throw new Error(`Graph relationship references a missing search item: ${link.from} -> ${link.to}.`);
    }

    if (!isRelationshipExplainable(from, to, link)) {
      questionable.push(link);
    }
  }

  if (samplePaths.size >= 3 && graphLinks.length === 0) {
    throw new Error("Generated graph has no page-to-page relationships for a multi-file validation run.");
  }

  const semanticPathsWithLinks = Array.from(semanticPaths).filter((pagePath) => pagesWithGraphLinks.has(pagePath));
  const missingSemanticLinks = semanticPaths.size > 1 ? semanticPaths.size - semanticPathsWithLinks.length : 0;

  if (questionable.length > Math.max(3, Math.floor(graphLinks.length * 0.4))) {
    throw new Error(`Generated graph includes too many questionable relationships: ${questionable.length}/${graphLinks.length}.`);
  }

  const warnings = [];

  if (questionable.length > 0) {
    warnings.push(`Questionable relationships need review: ${questionable.length}/${graphLinks.length}`);
  }

  if (missingSemanticLinks > 0) {
    warnings.push(`Sampled pages without outgoing graph links: ${missingSemanticLinks}/${semanticPaths.size}`);
  }

  return {
    graphLinks: graphLinks.length,
    questionableGraphLinks: questionable.length,
    pagesWithGraphLinks: pagesWithGraphLinks.size,
    warnings
  };
}

function isRelationshipExplainable(from, to, link) {
  const fromTokens = contentTokens([
    from.title,
    from.type,
    from.description,
    from.tags,
    from.keywords,
    from.metadata
  ]);
  const toTokens = contentTokens([
    to.title,
    to.type,
    to.description,
    to.tags,
    to.keywords,
    to.metadata,
    link.reason,
    link.label,
    link.relation_type
  ]);
  const overlap = Array.from(fromTokens).filter((token) => toTokens.has(token));

  return overlap.length > 0;
}

function contentTokens(values) {
  const tokens = new Set();

  for (const value of values) {
    for (const token of tokenizeForRelevance(value)) {
      tokens.add(token);
    }
  }

  return tokens;
}

function tokenizeForRelevance(value) {
  const text = normalizeText(
    typeof value === "string" ? value : JSON.stringify(value ?? "")
  ).toLowerCase();
  const tokens = new Set();

  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    const token = match[0];

    if (!GENERIC_TOKENS.has(token)) {
      tokens.add(token);
    }
  }

  for (const match of text.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chunk = match[0];

    for (let index = 0; index < chunk.length - 1; index += 1) {
      const token = chunk.slice(index, index + 2);

      if (!GENERIC_TOKENS.has(token)) {
        tokens.add(token);
      }
    }

    for (let index = 0; index < chunk.length - 3; index += 1) {
      const token = chunk.slice(index, index + 4);

      if (!GENERIC_TOKENS.has(token)) {
        tokens.add(token);
      }
    }
  }

  return tokens;
}

function readSourceMarkdown(sample) {
  const sourceText = fs.readFileSync(sample.filePath, "utf8");
  const parsed = matter(sourceText);

  return {
    metadata: parsed.data ?? {},
    title: readString(parsed.data?.title) || sample.title,
    body: parsed.content
  };
}

function sourceBodySnippets(sourceBody) {
  const candidates = sourceBody
    .split(/\n+/)
    .map((line) => normalizeText(line.replace(/^#+\s*/, "")))
    .filter((line) => line.length >= 24 && !line.startsWith("---"))
    .slice(0, 8);

  return candidates.map((line) => line.slice(0, Math.min(42, line.length)));
}

function pagePathForSample(sample) {
  return `pages/${sample.relativePath ?? sample.basename}`;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .trim();
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}
