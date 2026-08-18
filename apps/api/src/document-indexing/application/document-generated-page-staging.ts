import { planGeneratedPageWrites } from "./document-generated-page-plan.js";
import { boundedConcurrentMap } from "./bounded-concurrent-map.js";

export type RenderedDocumentPage = {
  logicalPath: string;
  normalizedPath: string;
  entryKind: string;
  sourceFilePublicId: string | null;
  sourceRevisionPublicId: string | null;
  checksumSha256: string;
  byteCount: number;
  bytes: Uint8Array;
};

export type StagedDocumentPage = Omit<RenderedDocumentPage, "bytes"> & {
  pageCandidatePublicId: string;
  objectId: string;
};

type CurrentDocumentPage = {
  logicalPath: string;
  normalizedPath: string;
  checksumSha256: string;
  objectId: string;
};

export function createDocumentGeneratedPageStaging(input: {
  writeConcurrency: number;
  write(page: RenderedDocumentPage): Promise<{
    objectId: string;
    checksumSha256: string;
    byteCount: number;
  }>;
  stage(pages: ReadonlyArray<Omit<StagedDocumentPage,
    "pageCandidatePublicId">>): Promise<readonly StagedDocumentPage[]>;
  attach?(input: {
    pageCandidatePublicId: string;
    objectId: string;
  }): Promise<void>;
}) {
  return async (request: {
    desired: readonly RenderedDocumentPage[];
    current: readonly CurrentDocumentPage[];
    affectedNormalizedPaths: readonly string[];
    signal?: AbortSignal;
  }): Promise<{
    pageCandidates: readonly StagedDocumentPage[];
    removedNormalizedPaths: readonly string[];
    writtenObjectCount: number;
  }> => {
    const plan = planGeneratedPageWrites({
      desired: request.desired,
      current: request.current,
      affectedNormalizedPaths: request.affectedNormalizedPaths
    });
    const objects = new Map<string, {
      objectId: string;
      checksumSha256: string;
      byteCount: number;
    }>();
    const written = await boundedConcurrentMap({
      values: plan.write,
      concurrency: input.writeConcurrency,
      ...(request.signal ? { signal: request.signal } : {}),
      async map(page) {
        const rendered = requireRendered(request.desired, page.normalizedPath);
        const stored = await input.write(rendered);
        if (stored.checksumSha256 !== rendered.checksumSha256
          || stored.byteCount !== rendered.byteCount || !stored.objectId) {
          throw pageStagingError("stored_object_mismatch");
        }
        return { normalizedPath: page.normalizedPath, stored };
      }
    });
    for (const result of written) {
      objects.set(result.normalizedPath, result.stored);
    }
    for (const page of plan.reuse) {
      objects.set(page.normalizedPath, {
        objectId: page.objectId,
        checksumSha256: page.checksumSha256,
        byteCount: page.byteCount
      });
    }
    const stagedInput = request.desired.map((page) => {
      const object = objects.get(page.normalizedPath);
      if (!object) throw pageStagingError("page_object_missing");
      return {
        logicalPath: page.logicalPath,
        normalizedPath: page.normalizedPath,
        entryKind: page.entryKind,
        sourceFilePublicId: page.sourceFilePublicId,
        sourceRevisionPublicId: page.sourceRevisionPublicId,
        checksumSha256: object.checksumSha256,
        byteCount: object.byteCount,
        objectId: object.objectId
      };
    });
    const candidates = await input.stage(stagedInput);
    validateCandidates(candidates, stagedInput);
    if (input.attach) {
      for (const page of candidates) {
        await input.attach({
          pageCandidatePublicId: page.pageCandidatePublicId,
          objectId: page.objectId
        });
      }
    }
    return {
      pageCandidates: candidates,
      removedNormalizedPaths: plan.remove,
      writtenObjectCount: plan.write.length
    };
  };
}

function requireRendered(
  pages: readonly RenderedDocumentPage[],
  normalizedPath: string
): RenderedDocumentPage {
  const page = pages.find((item) => item.normalizedPath === normalizedPath);
  if (!page) throw pageStagingError("rendered_page_missing");
  return page;
}

function validateCandidates(
  candidates: readonly StagedDocumentPage[],
  expected: ReadonlyArray<Omit<StagedDocumentPage, "pageCandidatePublicId">>
): void {
  if (candidates.length !== expected.length) {
    throw pageStagingError("candidate_count_mismatch");
  }
  const byPath = new Map(expected.map((page) => [page.normalizedPath, page]));
  for (const candidate of candidates) {
    const page = byPath.get(candidate.normalizedPath);
    if (!page || !candidate.pageCandidatePublicId
      || candidate.logicalPath !== page.logicalPath
      || candidate.objectId !== page.objectId
      || candidate.checksumSha256 !== page.checksumSha256
      || candidate.byteCount !== page.byteCount) {
      throw pageStagingError("candidate_mismatch");
    }
  }
}

function pageStagingError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document page staging error: ${code}`), { code });
}
