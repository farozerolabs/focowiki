import type {
  OkfGraphNode,
  SourceMetadataDefaults,
  SourceModelSuggestions
} from "@focowiki/okf";
import { resolveSourceMarkdownLinkDestination } from "@focowiki/okf";
import { buildSourceContentProfile, isUsefulTerm } from "./content-profile.js";
import {
  extractSearchTerms,
  readString,
  readStringArray,
  stripMarkdownExtension,
  unique
} from "./graph-utils.js";

export function createGraphNode(input: {
  sourceFileId: string;
  sourceRelativePath: string;
  metadata: SourceMetadataDefaults;
  body: string;
  suggestions: SourceModelSuggestions | null;
}): OkfGraphNode {
  const sourceName = input.sourceRelativePath.split("/").at(-1) ?? input.sourceRelativePath;
  const title = readString(input.metadata.title) || stripMarkdownExtension(sourceName);
  const profile = buildSourceContentProfile({
    title,
    body: input.body,
    metadata: input.metadata,
    suggestions: input.suggestions
  });
  const tags = unique([...readStringArray(input.metadata.tags), ...profile.tags]).filter(isUsefulTerm);
  const keywords = unique([
    ...profile.keywords,
    ...profile.subjects,
    ...profile.entities,
    ...extractSearchTerms(title)
  ])
    .filter(isUsefulTerm)
    .slice(0, 80);
  const explicitReferences = unique([
    ...profile.explicitReferences,
    ...profile.explicitReferences.map((reference) =>
      resolveSourceMarkdownLinkDestination(reference, input.sourceRelativePath)
    )
  ]);
  const relationshipHints = unique([
    ...profile.relationshipHints,
    ...explicitReferences
  ]);

  return {
    fileId: input.sourceFileId,
    path: `pages/${input.sourceRelativePath}`,
    title,
    ...(readString(input.metadata.type) ? { type: readString(input.metadata.type) } : {}),
    ...(profile.description ? { description: profile.description } : {}),
    ...(profile.summary ? { summary: profile.summary } : {}),
    subjects: profile.subjects,
    tags,
    entities: profile.entities,
    explicitReferences,
    relationshipHints,
    headings: profile.headingOutline,
    keywords,
    language: profile.language,
    profileVersion: profile.profileVersion,
    profileSource: profile.profileSource,
    metadata: {
      ...input.metadata,
      contentProfile: {
        summary: profile.summary,
        subjects: profile.subjects,
        keywords: profile.keywords,
        entities: profile.entities,
        explicitReferences,
        relationshipHints,
        definitions: profile.definitions,
        processHints: profile.processHints,
        versionHints: profile.versionHints,
        evidencePhrases: profile.evidencePhrases,
        headingOutline: profile.headingOutline,
        language: profile.language,
        profileVersion: profile.profileVersion,
        profileSource: profile.profileSource
      }
    }
  };
}
