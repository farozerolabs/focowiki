import type { DocumentDirectoryNavigationMutation } from
  "./document-directory-navigation-mutation.js";
import { validateDocumentDirectoryNavigationMutations } from
  "./document-directory-navigation-mutation.js";
import type { StagedDocumentPage } from
  "./document-generated-page-staging.js";

type ScopeOutputPage = Omit<StagedDocumentPage, "pageCandidatePublicId">;

export function mergeDocumentProjectionScopeOutputs(input: {
  outputs: readonly {
    pages: readonly ScopeOutputPage[];
    removedNormalizedPaths: readonly string[];
    navigationMutations: readonly DocumentDirectoryNavigationMutation[];
  }[];
  candidates: readonly StagedDocumentPage[];
}): {
  pageCandidates: readonly StagedDocumentPage[];
  removedPageNormalizedPaths: readonly string[];
  navigationMutations: readonly DocumentDirectoryNavigationMutation[];
} {
  const outputPages = collectDocumentProjectionScopeOutputPages(input.outputs);
  const removed = new Set<string>();
  const mutations = new Map<string, DocumentDirectoryNavigationMutation>();
  for (const output of input.outputs) {
    validateDocumentDirectoryNavigationMutations(output.navigationMutations);
    for (const path of output.removedNormalizedPaths) removed.add(path);
    for (const mutation of output.navigationMutations) {
      const current = mutations.get(mutation.directoryPath);
      if (current && canonicalJson(current) !== canonicalJson(mutation)) {
        throw mergeError("projection_scope_navigation_conflict");
      }
      mutations.set(mutation.directoryPath, mutation);
    }
  }
  const candidateByPath = new Map(input.candidates.map((candidate) => [
    candidate.normalizedPath,
    candidate
  ]));
  const pageCandidates = outputPages.map((page) => {
    const candidate = candidateByPath.get(page.normalizedPath);
    if (!candidate || !samePage(page, candidate)) {
      throw mergeError("projection_scope_candidate_missing");
    }
    return candidate;
  }).sort(comparePage);
  for (const page of pageCandidates) removed.delete(page.normalizedPath);
  return {
    pageCandidates,
    removedPageNormalizedPaths: [...removed].sort(),
    navigationMutations: [...mutations.values()].sort((left, right) =>
      left.directoryPath.localeCompare(right.directoryPath, "en-US"))
  };
}

export function collectDocumentProjectionScopeOutputPages(outputs: readonly {
  pages: readonly ScopeOutputPage[];
}[]): readonly ScopeOutputPage[] {
  const outputPages = new Map<string, ScopeOutputPage>();
  for (const output of outputs) {
    for (const page of output.pages) {
      const current = outputPages.get(page.normalizedPath);
      if (current && !samePage(current, page)) {
        throw mergeError("projection_scope_page_conflict");
      }
      outputPages.set(page.normalizedPath, page);
    }
  }
  return [...outputPages.values()].sort((left, right) =>
    left.normalizedPath.localeCompare(right.normalizedPath, "en-US"));
}

function samePage(
  left: ScopeOutputPage,
  right: ScopeOutputPage
): boolean {
  return left.logicalPath === right.logicalPath
    && left.normalizedPath === right.normalizedPath
    && left.entryKind === right.entryKind
    && left.sourceFilePublicId === right.sourceFilePublicId
    && left.sourceRevisionPublicId === right.sourceRevisionPublicId
    && left.objectId === right.objectId
    && left.checksumSha256 === right.checksumSha256
    && left.byteCount === right.byteCount;
}

function comparePage(
  left: StagedDocumentPage,
  right: StagedDocumentPage
): number {
  return left.normalizedPath.localeCompare(right.normalizedPath, "en-US");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function mergeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Projection scope output merge error: ${code}`), {
    code
  });
}
