export const GENERATED_GRAPH_RESOURCES = Object.freeze({
  index: Object.freeze({
    path: "_graph/index.md",
    label: "Relationship graph",
    description: "Follow generated relationships to source-backed Markdown files."
  }),
  rootDirectoryPath: "_graph",
  nodeDirectoryPath: "_graph/graph_node/v1",
  edgeDirectoryPath: "_graph/graph_edge/v1",
  byFileDirectoryPath: "_graph/by-file",
  catalogPath: "_index/catalog.json"
});

export const REQUIRED_GENERATED_NAVIGATION_RESOURCES = Object.freeze([
  Object.freeze({ path: "index.md", refKind: "root" }),
  Object.freeze({ path: "pages/index.md", refKind: "directory_root" }),
  Object.freeze({ path: "schema.md", refKind: "root" }),
  Object.freeze({ path: "log.md", refKind: "root" }),
  Object.freeze({ path: "_index/index.md", refKind: "root" }),
  Object.freeze({ path: GENERATED_GRAPH_RESOURCES.index.path, refKind: "root" }),
  Object.freeze({ path: GENERATED_GRAPH_RESOURCES.catalogPath, refKind: "root" })
]);

export const REQUIRED_GENERATED_NAVIGATION_PATHS = Object.freeze(
  REQUIRED_GENERATED_NAVIGATION_RESOURCES.map((resource) => resource.path)
);

export const GENERATED_ROOT_MANIFEST_PATHS = Object.freeze(
  REQUIRED_GENERATED_NAVIGATION_RESOURCES
    .filter((resource) => resource.refKind === "root")
    .map((resource) => resource.path)
);

export function graphFileContentAction(knowledgeBaseId: string, path: string): string {
  return `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=${encodeURIComponent(path)}`;
}

export function graphTreeAction(knowledgeBaseId: string, parentPath: string): string {
  return `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?parentPath=${encodeURIComponent(parentPath)}`;
}
