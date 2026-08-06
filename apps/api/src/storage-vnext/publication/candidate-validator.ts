import { createHash } from "node:crypto";
import { isAllowedPublicGeneratedFilePath } from "../../public-generated-path.js";
import type {
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort
} from "../release/ports.js";
import type {
  StorageVnextSearchProjectionRecord,
  StorageVnextSearchProjectionRepository
} from "../search/projection-repository.js";
import {
  STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS,
  resolveStorageVnextMarkdownTargets
} from "./validation.js";
import {
  compareStorageVnextEffectiveCatalogPaths,
  type StorageVnextEffectiveCatalogPort
} from "./effective-catalog.js";

type ReleasePort = Pick<
  StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
  | "getLiveCandidate"
  | "listCandidateDependencies"
  | "listCandidateShards"
  | "getKnowledgeBaseSummary"
  | "countCandidateOwnedObjects"
  | "markCandidateValidating"
  | "recordCandidateValidation"
  | "markCandidateReady"
>;

type ObjectValidationPort = {
  verify(input: {
    objectId: string;
    checksum: string;
    byteCount: number;
  }): Promise<boolean>;
  readText(input: {
    objectId: string;
    checksum: string;
    byteCount: number;
    maximumBytes: number;
  }): Promise<string>;
};

export function createStorageVnextPublicationCandidateValidator(input: {
  releases: ReleasePort;
  effectiveCatalog: StorageVnextEffectiveCatalogPort;
  objects: ObjectValidationPort;
  search: Pick<StorageVnextSearchProjectionRepository, "getCandidate">;
  clock: () => string;
  limits: {
    maximumPageSize: number;
    maximumMarkdownBytes: number;
    objectReadConcurrency: number;
  };
}) {
  validateLimits(input.limits);
  return {
    async validate(request: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      searchProjectionPublicId: string;
    }) {
      const candidate = await requireCandidate(input.releases, request);
      if (candidate.state === "building") {
        const changed = await input.releases.markCandidateValidating({
          candidatePublicId: candidate.publicId
        });
        if (!changed) throw new Error("Storage vNext publication validation transition failed");
      } else if (candidate.state !== "validating") {
        throw new Error("Storage vNext publication candidate is not validatable");
      }

      const catalog = await validateCatalog(input, request, candidate.candidateRootPublicId);
      await validateShards(input, request.candidatePublicId);
      const linkCount = await countLinkDependencies(input, request.candidatePublicId);
      const summary = await input.releases.getKnowledgeBaseSummary({
        knowledgeBaseId: request.knowledgeBaseId,
        releaseRootPublicId: candidate.candidateRootPublicId
      });
      if (!summary || summary.generatedEntryCount !== catalog.entryCount) {
        throw new Error("Storage vNext publication summary count is inconsistent");
      }
      const search = await requireSearch(input.search, request);
      const manifestChecksum = catalog.manifest.digest("hex");
      const objectOwnerCount = await input.releases.countCandidateOwnedObjects(
        request.candidatePublicId
      );
      if (!Number.isSafeInteger(objectOwnerCount) || objectOwnerCount < 0) {
        throw new Error("Storage vNext publication object owner count is invalid");
      }
      const receipt = {
        candidatePublicId: request.candidatePublicId,
        manifestChecksum,
        searchProjectionPublicId: request.searchProjectionPublicId,
        objectOwnerCount,
        searchDocumentCount: search.documentCount,
        graphNodeCount: summary.graphNodeCount,
        graphEdgeCount: summary.graphEdgeCount,
        linkCount,
        generatedEntryCount: summary.generatedEntryCount,
        objectValidationPassed: true,
        searchValidationPassed: true,
        graphValidationPassed: true,
        linkValidationPassed: true,
        countValidationPassed: true,
        pathValidationPassed: true,
        validatedAt: input.clock()
      } as const;
      if (!await input.releases.recordCandidateValidation(receipt)) {
        throw new Error("Storage vNext publication validation receipt was rejected");
      }
      if (!await input.releases.markCandidateReady({
        candidatePublicId: request.candidatePublicId,
        manifestChecksum
      })) throw new Error("Storage vNext publication candidate could not become ready");
      return receipt;
    }
  };
}

async function validateCatalog(
  input: Parameters<typeof createStorageVnextPublicationCandidateValidator>[0],
  request: { knowledgeBaseId: string; candidatePublicId: string },
  candidateRootPublicId: string
) {
  const manifest = createHash("sha256");
  const required: string[] = [];
  let cursor: string | null = null;
  let previousLogicalPath: string | null = null;
  let entryCount = 0;
  do {
    const page = await input.effectiveCatalog.listEffectiveCatalogEntries({
      ...request,
      limit: input.limits.maximumPageSize,
      cursor
    });
    if (page.items.length > input.limits.maximumPageSize) {
      throw new Error("Storage vNext publication catalog page exceeds its budget");
    }
    const linkTargets: string[] = [];
    for (const entry of page.items) {
      if (
        (previousLogicalPath !== null
          && compareStorageVnextEffectiveCatalogPaths(
            previousLogicalPath,
            entry.logicalPath
          ) >= 0)
        || !isAllowedPublicGeneratedFilePath(entry.logicalPath)
      ) throw new Error("Storage vNext publication catalog entry is invalid");
      previousLogicalPath = entry.logicalPath;
      if (entry.kind === "source" && !entry.logicalPath.startsWith("pages/")) {
        throw new Error("Storage vNext publication source mapping is invalid");
      }
    }
    const markdownBodies = await mapWithConcurrency(
      page.items,
      input.limits.objectReadConcurrency,
      async (entry) => entry.logicalPath.endsWith(".md")
        ? await input.objects.readText({
            objectId: entry.objectId,
            checksum: entry.checksum,
            byteCount: entry.byteCount,
            maximumBytes: input.limits.maximumMarkdownBytes
          })
        : await verifyNonMarkdownEntry(input.objects, entry)
    );
    for (const [index, entry] of page.items.entries()) {
      const markdownBody = markdownBodies[index] ?? null;
      if (required.length < STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS.length) {
        required.push(entry.logicalPath);
      }
      manifest.update(`${JSON.stringify({
        path: entry.logicalPath,
        kind: entry.kind,
        source: entry.sourceFilePublicId,
        checksum: entry.checksum,
        bytes: entry.byteCount,
        ordinal: entry.ordinal
      })}\n`);
      if (markdownBody !== null) {
        linkTargets.push(...resolveStorageVnextMarkdownTargets(
          entry.logicalPath,
          markdownBody
        ));
      }
      entryCount += 1;
    }
    await assertLinkTargets(input, request, linkTargets);
    cursor = advancingCursor(cursor, page.nextCursor, "catalog");
  } while (cursor !== null);
  if (JSON.stringify(required) !== JSON.stringify(STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS)) {
    throw new Error("Storage vNext publication required navigation order changed");
  }
  manifest.update(`root:${candidateRootPublicId}\nentries:${entryCount}\n`);
  return { manifest, entryCount };
}

async function assertLinkTargets(
  input: Parameters<typeof createStorageVnextPublicationCandidateValidator>[0],
  request: { knowledgeBaseId: string; candidatePublicId: string },
  targets: readonly string[]
): Promise<void> {
  for (let offset = 0; offset < targets.length; offset += input.limits.maximumPageSize) {
    const logicalPaths = [...new Set(targets.slice(
      offset,
      offset + input.limits.maximumPageSize
    ))];
    const missing = await input.effectiveCatalog.findMissingLogicalPaths({
      ...request,
      logicalPaths
    });
    if (missing.length > 0) {
      throw new Error(`Storage vNext publication link target is missing: ${missing[0]}`);
    }
  }
}

async function validateShards(
  input: Parameters<typeof createStorageVnextPublicationCandidateValidator>[0],
  candidatePublicId: string
): Promise<void> {
  let cursor: string | null = null;
  do {
    const page = await input.releases.listCandidateShards({
      candidatePublicId,
      limit: input.limits.maximumPageSize,
      cursor
    });
    await mapWithConcurrency(
      page.items,
      input.limits.objectReadConcurrency,
      async (shard) => {
        if (!await input.objects.verify(shard)) {
          throw new Error("Storage vNext publication shard object is invalid");
        }
      }
    );
    cursor = advancingCursor(cursor, page.nextCursor, "shard");
  } while (cursor !== null);
}

async function countLinkDependencies(
  input: Parameters<typeof createStorageVnextPublicationCandidateValidator>[0],
  candidatePublicId: string
): Promise<number> {
  let cursor: string | null = null;
  let count = 0;
  do {
    const page = await input.releases.listCandidateDependencies({
      candidatePublicId,
      limit: input.limits.maximumPageSize,
      cursor
    });
    count += page.items.filter((item) => item.kind === "link").length;
    cursor = advancingCursor(cursor, page.nextCursor, "dependency");
  } while (cursor !== null);
  return count;
}

async function requireCandidate(
  releases: ReleasePort,
  request: { knowledgeBaseId: string; candidatePublicId: string }
) {
  const candidate = await releases.getLiveCandidate(request.knowledgeBaseId);
  if (!candidate || candidate.publicId !== request.candidatePublicId) {
    throw new Error("Storage vNext publication candidate is unavailable");
  }
  return candidate;
}

async function requireSearch(
  search: Pick<StorageVnextSearchProjectionRepository, "getCandidate">,
  request: {
    knowledgeBaseId: string;
    searchProjectionPublicId: string;
  }
): Promise<StorageVnextSearchProjectionRecord> {
  const candidate = await search.getCandidate(request.searchProjectionPublicId);
  if (
    !candidate
    || candidate.knowledgeBaseId !== request.knowledgeBaseId
    || candidate.state !== "ready"
  ) throw new Error("Storage vNext unified search candidate is not ready");
  return candidate;
}

function advancingCursor(previous: string | null, next: string | null, kind: string) {
  if (next !== null && next === previous) {
    throw new Error(`Storage vNext publication ${kind} cursor did not advance`);
  }
  return next;
}

function validateLimits(limits: {
  maximumPageSize: number;
  maximumMarkdownBytes: number;
  objectReadConcurrency: number;
}) {
  if (
    !Number.isSafeInteger(limits.maximumPageSize)
    || limits.maximumPageSize < 1
    || limits.maximumPageSize > 1_000
    || !Number.isSafeInteger(limits.maximumMarkdownBytes)
    || limits.maximumMarkdownBytes < 1
    || !Number.isSafeInteger(limits.objectReadConcurrency)
    || limits.objectReadConcurrency < 1
    || limits.objectReadConcurrency > 32
  ) throw new Error("Storage vNext publication validation limits are invalid");
}

async function verifyNonMarkdownEntry(
  objects: ObjectValidationPort,
  entry: Parameters<ObjectValidationPort["verify"]>[0]
): Promise<null> {
  if (!await objects.verify(entry)) {
    throw new Error("Storage vNext publication catalog entry is invalid");
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  apply: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await apply(items[index]!);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
