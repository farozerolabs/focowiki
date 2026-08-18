import {
  buildOkfGeneratedMetadata,
  canonicalizeSourceMarkdownLinks,
  canonicalizeOptionalGeneratedTextIdentity,
  portableMarkdownHref,
  portableizeSourceMarkdownLinks,
  prepareGeneratedMarkdownBody,
  renderMarkdownIdentityLabel,
  validatePortableGeneratedText,
  type SourceMetadata,
  type SourceMetadataDefaults,
  type SourceModelSuggestions
} from "@focowiki/okf";
import {
  removeDeletedSourceMarkdownLinks,
  rewriteMovedSourceMarkdownLinks,
  type SourcePathRewrite
} from "./deleted-source-links.js";

export type GeneratedPageSummary = {
  pagePath: string;
  metadata: SourceMetadata;
  sourceMetadata?: SourceMetadataDefaults;
  suggestions: SourceModelSuggestions | null;
  graphLinks?: GeneratedGraphLink[];
  semanticContext?: {
    entities: readonly {
      label: string;
      kind: string;
      description: string | null;
      confidence: number;
      evidencePaths: readonly string[];
    }[];
  };
};

type GeneratedGraphLink = {
  path: string;
  title: string;
  relationType: string;
  direction: "incoming" | "outgoing";
  weight: number;
  reason: string;
};

export function renderPageFile(
  page: GeneratedPageSummary,
  body: string,
  options: {
    sourceLinkBaseLogicalPath?: string;
    removedSourceLogicalPaths?: readonly string[];
    sourcePathRewrites?: readonly SourcePathRewrite[];
  } = {}
): string {
  const prepared = prepareSourceBodyForGeneration(
    body,
    page.pagePath,
    options.sourceLinkBaseLogicalPath,
    options.removedSourceLogicalPaths ?? [],
    options.sourcePathRewrites ?? []
  );
  const canonicalBody = canonicalizeFirstHeading(
    prepared.content,
    page.metadata.title
  );
  const metadata = buildOkfGeneratedMetadata({
    ownership: "source",
    metadata: page.sourceMetadata ?? page.metadata
  });
  return renderConceptFile(metadata, [
    canonicalBody,
    "",
    ...renderSemanticContext(page.pagePath, page.semanticContext?.entities ?? []),
    ...renderRelatedLinks(
      page.pagePath,
      page.metadata.title,
      page.graphLinks ?? []
    ),
    ...(prepared.trailingCitations ? ["", prepared.trailingCitations] : [])
  ].join("\n"));
}

export function prepareSourceBodyForGeneration(
  body: string,
  pagePath: string,
  sourceLinkBaseLogicalPath: string | undefined = undefined,
  removedSourceLogicalPaths: readonly string[] = [],
  sourcePathRewrites: readonly SourcePathRewrite[] = []
): ReturnType<typeof prepareGeneratedMarkdownBody> {
  const prepared = prepareGeneratedMarkdownBody(body);
  const rewriteSourceLinkBase = sourcePathRewrites.find((rewrite) =>
    rewrite.sourceLinkBase?.sourceFilePublicId
    && rewrite.sourceLinkBase.logicalPath
    && rewrite.to === pagePath
  )?.sourceLinkBase?.logicalPath;
  const sourceLinkBase = sourceLinkBaseLogicalPath ?? rewriteSourceLinkBase;
  const canonicalBody = canonicalizeSourceMarkdownLinks(
    prepared.content,
    (sourceLinkBase ?? pagePath).replace(/^pages\//u, "")
  );
  const removedPaths = [
    ...removedSourceLogicalPaths,
    ...sourcePathRewrites.flatMap((rewrite) => rewrite.to === null
      ? [rewrite.from] : [])
  ];
  return {
    ...prepared,
    content: portableizeSourceMarkdownLinks(
      removeDeletedSourceMarkdownLinks(
        rewriteMovedSourceMarkdownLinks(canonicalBody, sourcePathRewrites),
        removedPaths
      ),
      pagePath
    )
  };
}

function renderSemanticContext(pagePath: string, entities: readonly {
  label: string;
  kind: string;
  description: string | null;
  confidence: number;
  evidencePaths: readonly string[];
}[]): string[] {
  if (entities.length === 0) return [];
  return [
    "",
    "## Concepts",
    "",
    ...entities.map((entity) => {
      const label = renderMarkdownIdentityLabel(entity.label);
      const kind = renderMarkdownIdentityLabel(entity.kind);
      const description = canonicalizeOptionalGeneratedTextIdentity(
        entity.description ?? ""
      );
      const evidence = entity.evidencePaths[0]
        ? ` [Source evidence](${portableMarkdownHref(
          pagePath, entity.evidencePaths[0])})`
        : "";
      const detail = description
        ? ` — ${renderMarkdownIdentityLabel(description)}` : "";
      return `- **${label}** (\`${kind}\`)${detail}${evidence}`;
    })
  ];
}

function renderRelatedLinks(
  pagePath: string,
  sourceTitle: string,
  graphLinks: GeneratedGraphLink[]
): string[] {
  const links = graphLinks.map((link) => {
    const title = renderMarkdownIdentityLabel(
      canonicalizeOptionalGeneratedTextIdentity(link.title) ?? "Related concept"
    );
    const reason = canonicalizeOptionalGeneratedTextIdentity(link.reason)
      || `Related through ${humanizeRelationshipType(link.relationType)}.`;
    validatePortableGeneratedText(reason, {
      userText: [sourceTitle, link.title]
    });
    return `- [${title}](${portableMarkdownHref(pagePath, link.path)}) - ${
      renderMarkdownIdentityLabel(reason)}`;
  });
  return links.length > 0 ? ["", "## Related", "", ...links] : [];
}

function humanizeRelationshipType(value: string): string {
  return canonicalizeOptionalGeneratedTextIdentity(value.replace(/[_-]+/gu, " "))
    || "a documented relationship";
}

function canonicalizeFirstHeading(body: string, title: string): string {
  const heading = `# ${renderMarkdownIdentityLabel(title)}`;
  if (/^#\s+.+$/mu.test(body)) return body.replace(/^#\s+.+$/mu, heading);
  return `${heading}\n\n${body}`.trimEnd();
}

function renderConceptFile(metadata: Record<string, unknown>, body: string): string {
  return ["---", ...serializeYamlRecord(metadata), "---", body.trim()]
    .join("\n").trimEnd();
}

function serializeYamlRecord(record: Record<string, unknown>): string[] {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => Array.isArray(value)
      ? value.length === 0 ? [`${key}: []`]
        : [`${key}:`, ...value.map((item) => `  - ${JSON.stringify(item)}`)]
      : [`${key}: ${JSON.stringify(value)}`]);
}
