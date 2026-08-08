export const STORAGE_VNEXT_LEGACY_NAVIGATION_PROFILE = 0;
export const STORAGE_VNEXT_CURRENT_NAVIGATION_PROFILE = 1;
export const STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES = [
  "_index/manifest/v1",
  "_index/search/v1",
  "_index/links/v1",
  "_index/tree/v1",
  "_graph/graph_node/v1",
  "_graph/graph_edge/v1",
  "_graph/by-file"
] as const;
export const STORAGE_VNEXT_EXTENSION_NAVIGATION_STATE_DIRECTORY_COUNT =
  STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES.length;
export const STORAGE_VNEXT_MINIMUM_EXTENSION_NAVIGATION_MARKDOWN_COUNT = 3;
