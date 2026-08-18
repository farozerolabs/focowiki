import { posix } from "node:path";
import type { DocumentTermBucket } from "./document-term-routing.js";

type SourcePath = Readonly<{
  sourceFilePublicId: string;
  logicalPath: string;
}>;

export function documentDeletionProjectionScopes(input: {
  deletedSources: readonly SourcePath[];
  affectedSurvivors: readonly SourcePath[];
  obsoleteRelationPublicIds: readonly string[];
  termBuckets: readonly DocumentTermBucket[];
}) {
  const sources = uniqueSources([
    ...input.deletedSources,
    ...input.affectedSurvivors
  ]);
  const directories = [...new Set(sources.flatMap((source) =>
    pageDirectoryAncestors(`pages/${source.logicalPath}`)))];
  const graphChanged = input.obsoleteRelationPublicIds.length > 0;
  const scopes = [
    ...directories.map((key) => ({
      kind: "_index" as const,
      key: `pages:${key}`
    })),
    ...input.termBuckets.map((bucket) => ({
      kind: "_index" as const,
      key: `term:${bucket}`
    })),
    ...(input.termBuckets.length > 0
      ? [{ kind: "_index" as const, key: "term-catalog" }] : []),
    ...(graphChanged ? [
      ...directories.map((key) => ({
        kind: "_graph" as const,
        key: `directory:${key}`
      })),
      ...directories.map((key) => ({
        kind: "_graph" as const,
        key: `file-directory:${key}`
      })),
      ...sources.map((source) => ({
        kind: "_graph" as const,
        key: source.sourceFilePublicId
      })),
      { kind: "_graph" as const, key: "catalog" }
    ] : []),
    { kind: "root" as const, key: "index" }
  ];
  return [...new Map(scopes.map((scope) => [
    `${scope.kind}\0${scope.key}`,
    scope
  ])).values()].sort((left, right) =>
    left.kind.localeCompare(right.kind, "en-US")
    || left.key.localeCompare(right.key, "en-US"));
}

function uniqueSources(sources: readonly SourcePath[]): SourcePath[] {
  return [...new Map(sources.map((source) => [
    source.sourceFilePublicId,
    source
  ])).values()];
}

function pageDirectoryAncestors(pagePath: string): string[] {
  const directories = [posix.dirname(pagePath)];
  while (directories.at(-1) !== "pages") {
    directories.push(posix.dirname(directories.at(-1)!));
  }
  return directories.reverse();
}
