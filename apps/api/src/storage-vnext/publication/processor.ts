import type {
  StorageVnextSearchCandidateBuildResult
} from "../search/streaming-builder.js";
import type {
  StorageVnextSearchProjectionPort,
  StorageVnextSearchValidationCase
} from "../search/ports.js";
import {
  isSearchProviderKind,
  type SearchProviderKind
} from "../../application/ports/search-provider-runtime.js";

type PublicationIdentity = {
  knowledgeBaseId: string;
  candidatePublicId: string;
  operationPublicId: string;
  signal: AbortSignal;
};

type PublicationProcessorInput = {
  selectedSearchProviderKind: SearchProviderKind;
  activeSearchProjections: {
    getActiveProjection(knowledgeBaseId: string): Promise<{
      publicId: string;
      providerKind: SearchProviderKind;
    } | null>;
  };
  search: Pick<
    StorageVnextSearchProjectionPort,
    "prepareCandidate" | "validateCandidate"
  >;
  searchBuilder: {
    build(input: PublicationIdentity): Promise<StorageVnextSearchCandidateBuildResult>;
  };
  graph: {
    reconcile(input: PublicationIdentity & {
      searchProjectionPublicId: string;
    }): Promise<void>;
  };
  artifacts: {
    publish(input: PublicationIdentity & {
      searchProjectionPublicId: string;
    }): Promise<void>;
  };
  releases: {
    getCandidate(input: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      operationPublicId: string;
    }): Promise<{
      state: "building" | "validating" | "ready";
      updatedAt: string;
      factRevision: number;
    } | null>;
    validate(input: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      searchProjectionPublicId: string;
      expectedCandidateFactRevision?: number;
    }): Promise<unknown>;
  };
  schemaChecksum: string;
  settingsChecksum: string;
  queryCases: readonly StorageVnextSearchValidationCase[];
  maxP95ProcessingTimeMs: number;
};

export function createStorageVnextPublicationProcessor(
  input: PublicationProcessorInput
) {
  validateConfiguration(input);
  return {
    async publish(request: PublicationIdentity): Promise<{
      searchProjectionPublicId: string;
    }> {
      validateIdentity(request);
      throwIfAborted(request.signal);
      const activeSearchProjection = await input.activeSearchProjections
        .getActiveProjection(request.knowledgeBaseId);
      throwIfAborted(request.signal);
      const retainActiveSearch = activeSearchProjection !== null
        && activeSearchProjection.providerKind !== input.selectedSearchProviderKind;
      const searchProjectionPublicId = retainActiveSearch
        ? activeSearchProjection.publicId
        : request.candidatePublicId;
      const candidate = await input.releases.getCandidate({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: request.candidatePublicId,
        operationPublicId: request.operationPublicId
      });
      if (!candidate) throw processorError("candidate_unavailable");
      if (candidate.state === "ready") return { searchProjectionPublicId };
      if (candidate.state === "validating") {
        await input.releases.validate({
          knowledgeBaseId: request.knowledgeBaseId,
          candidatePublicId: request.candidatePublicId,
          searchProjectionPublicId
        });
        return { searchProjectionPublicId };
      }
      let search: StorageVnextSearchCandidateBuildResult | null = null;
      if (!retainActiveSearch) {
        await input.search.prepareCandidate({
          knowledgeBaseId: request.knowledgeBaseId,
          candidatePublicId: searchProjectionPublicId,
          schemaChecksum: input.schemaChecksum,
          settingsChecksum: input.settingsChecksum
        });
        throwIfAborted(request.signal);
        search = await input.searchBuilder.build(request);
        validateBuildResult(search);
        throwIfAborted(request.signal);
        await input.graph.reconcile({
          ...request,
          searchProjectionPublicId
        });
        throwIfAborted(request.signal);
      }
      await input.artifacts.publish({
        ...request,
        searchProjectionPublicId
      });
      throwIfAborted(request.signal);
      if (search) {
        await input.search.validateCandidate({
          candidatePublicId: searchProjectionPublicId,
          expectedDocumentCount: search.documentCount,
          documentChecksum: search.documentChecksum,
          schemaChecksum: input.schemaChecksum,
          settingsChecksum: input.settingsChecksum,
          queryCases: input.queryCases.length > 0
            ? input.queryCases
            : search.queryCases,
          maxP95ProcessingTimeMs: input.maxP95ProcessingTimeMs
        });
        throwIfAborted(request.signal);
      }
      const completedCandidate = await input.releases.getCandidate({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: request.candidatePublicId,
        operationPublicId: request.operationPublicId
      });
      if (!completedCandidate || completedCandidate.state !== "building") {
        throw processorError("candidate_changed");
      }
      await input.releases.validate({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: request.candidatePublicId,
        searchProjectionPublicId,
        expectedCandidateFactRevision: completedCandidate.factRevision
      });
      return { searchProjectionPublicId };
    }
  };
}

function validateConfiguration(input: PublicationProcessorInput): void {
  if (
    !isSearchProviderKind(input.selectedSearchProviderKind)
    || !/^[0-9a-f]{64}$/u.test(input.schemaChecksum)
    || !/^[0-9a-f]{64}$/u.test(input.settingsChecksum)
    || !Number.isSafeInteger(input.maxP95ProcessingTimeMs)
    || input.maxP95ProcessingTimeMs < 1
    || input.queryCases.length > 1_000
  ) throw processorError("invalid_configuration");
}

function validateIdentity(input: PublicationIdentity): void {
  for (const value of [
    input.knowledgeBaseId,
    input.candidatePublicId,
    input.operationPublicId
  ]) {
    if (!value || Buffer.byteLength(value) > 255) {
      throw processorError("invalid_identity");
    }
  }
}

function validateBuildResult(result: StorageVnextSearchCandidateBuildResult): void {
  if (
    !/^[0-9a-f]{64}$/u.test(result.documentChecksum)
    || [
      result.sourceCount,
      result.graphSeedCount,
      result.documentCount,
      result.batchCount,
      result.compressedBytes
    ].some((value) => !Number.isSafeInteger(value) || value < 0)
    || result.graphSeedCount > result.sourceCount
  ) throw processorError("invalid_search_build_result");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Storage vNext publication aborted", "AbortError");
}

function processorError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext publication processor error: ${code}`),
    { code }
  );
}
