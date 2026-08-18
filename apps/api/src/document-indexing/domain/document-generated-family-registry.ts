export type DocumentGeneratedFamily = Readonly<{
  family: string;
  publicPaths: readonly string[];
  ownerModule: string | null;
}>;

export const DOCUMENT_GENERATED_FAMILY_REGISTRY: readonly DocumentGeneratedFamily[] =
  Object.freeze([
    family("root_navigation", ["index.md"], "document-generated-navigation"),
    family("content_history", ["log.md", "log-*.md"], "document-generated-navigation"),
    family("directory_navigation", ["pages/**/index.md"], "document-generated-navigation"),
    family("continuation_navigation", ["**/index-<stable-leaf-id>.md"], "document-generated-navigation"),
    family("source_page", ["pages/**/*.md"], "document-generated-page-renderer"),
    family("index_catalog", ["_index/catalog.json"], "document-scope-projector"),
    family("page_records", ["_index/pages/**/*.json"], "document-scope-projector"),
    family("navigation_terms", ["_index/terms/**/*.json"], "document-scope-projector"),
    family("graph_records", ["_graph/by-directory/**/*.json"], "document-scope-projector"),
    family("per_file_graph", ["_graph/by-file/**/*.json"], "document-scope-projector"),
    family("extension_navigation", ["_index/**/index*.md", "_graph/**/index*.md"], "document-scope-projector")
  ]);

function family(
  name: string,
  publicPaths: readonly string[],
  ownerModule: string | null
): DocumentGeneratedFamily {
  return Object.freeze({ family: name, publicPaths: Object.freeze([...publicPaths]), ownerModule });
}
