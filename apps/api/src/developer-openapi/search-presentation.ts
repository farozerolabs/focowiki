const PUBLIC_SEARCH_ITEM_FIELDS = [
  "generationId",
  "nodeId",
  "edgeId",
  "fileId",
  "generatedFileId",
  "knowledgeBaseId",
  "sourceFileId",
  "path",
  "generatedFilePath",
  "fileKind",
  "title",
  "description",
  "tags",
  "frontmatter",
  "matchedFields",
  "score",
  "contentAvailable",
  "matchType",
  "graphContext",
  "readActions"
] as const;

type PublicSearchItemField = (typeof PUBLIC_SEARCH_ITEM_FIELDS)[number];
type SearchPresentationInput = Record<string, unknown>;
export type DeveloperSearchItem = Partial<
  Record<PublicSearchItemField, unknown>
>;

export function presentDeveloperSearchItems<TItem extends SearchPresentationInput>(
  items: readonly TItem[]
): TItem[] {
  return items.map((item) => {
    const presented: DeveloperSearchItem = {};
    for (const field of PUBLIC_SEARCH_ITEM_FIELDS) {
      if (Object.hasOwn(item, field)) {
        presented[field] = item[field];
      }
    }
    return presented as TItem;
  });
}
