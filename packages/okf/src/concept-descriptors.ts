import { bundleSchemaTitle, knowledgeBaseTitle } from "./titles.js";
import { canonicalizeGeneratedTextIdentity } from "./text-identity.js";

export type GeneratedConceptDescriptor = {
  path: string;
  type: string;
  title: string;
  description: string;
  navigationLabel: string;
  heading: string;
  manifestIdentity: string;
};

export type GeneratedConceptFrontmatter = Pick<
  GeneratedConceptDescriptor,
  "type" | "title" | "description"
>;

type GeneratedConceptDescriptorInput = Omit<
  GeneratedConceptDescriptor,
  "navigationLabel" | "heading" | "manifestIdentity"
> & Partial<Pick<GeneratedConceptDescriptor, "navigationLabel" | "heading" | "manifestIdentity">>;

export function createGeneratedConceptDescriptor(
  input: GeneratedConceptDescriptorInput
): GeneratedConceptDescriptor {
  return {
    path: input.path,
    type: canonicalizeGeneratedTextIdentity(input.type, "concept type"),
    title: canonicalizeGeneratedTextIdentity(input.title, "concept title"),
    description: canonicalizeGeneratedTextIdentity(input.description, "concept description"),
    navigationLabel: canonicalizeGeneratedTextIdentity(
      input.navigationLabel ?? input.title,
      "concept navigation label"
    ),
    heading: canonicalizeGeneratedTextIdentity(input.heading ?? input.title, "concept heading"),
    manifestIdentity: input.manifestIdentity ?? input.path
  };
}

export function bundleSchemaDescriptor(title?: string): GeneratedConceptDescriptor {
  const resolvedKnowledgeBaseTitle = knowledgeBaseTitle(title);
  return createGeneratedConceptDescriptor({
    path: "schema.md",
    type: "Schema Reference",
    title: bundleSchemaTitle(title),
    description: `Metadata and navigation conventions for ${resolvedKnowledgeBaseTitle}.`,
    manifestIdentity: "schema"
  });
}

export function schemaReferenceDescriptor(input: {
  path: string;
  title: string;
  description: string;
}): GeneratedConceptDescriptor {
  return createGeneratedConceptDescriptor({
    ...input,
    type: "Schema Reference",
    manifestIdentity: `schema:${input.path}`
  });
}

export function directoryIndexPageDescriptor(input: {
  directoryPath: string;
  directoryTitle: string;
  page: number;
  start: number;
  end: number;
}): GeneratedConceptDescriptor {
  const pageName = `index-${padPage(input.page)}.md`;
  return createGeneratedConceptDescriptor({
    path: `${input.directoryPath}/${pageName}`,
    type: "Directory Index Page",
    title: `${input.directoryTitle} index page ${input.page}`,
    description: `Entries ${input.start} through ${input.end} for ${input.directoryPath}.`,
    manifestIdentity: `directory-index:${input.directoryPath}:${input.page}`
  });
}

export function directoryIndexMapDescriptor(input: {
  directoryPath: string;
  directoryTitle: string;
  page: number;
  pageCount: number;
}): GeneratedConceptDescriptor {
  const pageName = `index-map-${padPage(input.page)}.md`;
  return createGeneratedConceptDescriptor({
    path: `${input.directoryPath}/${pageName}`,
    type: "Directory Index Map",
    title: `${input.directoryTitle} index map ${input.page}`,
    description: `Index shard catalog page ${input.page} of ${input.pageCount} for ${input.directoryPath}.`,
    manifestIdentity: `directory-index-map:${input.directoryPath}:${input.page}`
  });
}

export function updateHistoryPageDescriptor(page: number): GeneratedConceptDescriptor {
  return createGeneratedConceptDescriptor({
    path: `log-${padPage(page)}.md`,
    type: "Update History Page",
    title: `Update history page ${page}`,
    description: `Retained publication details for update history page ${page}.`,
    manifestIdentity: `update-history:${page}`
  });
}

export function generatedConceptFrontmatter(
  descriptor: GeneratedConceptDescriptor
): GeneratedConceptFrontmatter {
  return {
    type: descriptor.type,
    title: descriptor.title,
    description: descriptor.description
  };
}

function padPage(value: number): string {
  return String(value).padStart(6, "0");
}
