import type {
  SearchEngineSettings,
  SearchEngineTransport
} from "../../application/ports/search-engine-transport.js";
import type { StorageVnextSearchProjectionPort } from "./ports.js";
import type { StorageVnextSearchProjectionRepository } from "./projection-repository.js";
import type { StorageVnextSearchHydrationPort } from "./search-hydration.js";
import { assertStorageVnextSearchHydration } from "./search-hydration.js";
import { parseStorageVnextSearchDocument } from "./document-codec.js";
import {
  createStorageVnextSearchDocumentSetAccumulator
} from "./document-set-checksum.js";
import {
  candidateValidationError,
  StorageVnextSearchCandidateValidationError
} from "./candidate-validation-errors.js";
import {
  createStorageVnextSearchSettingsChecksum
} from "./candidate-identity.js";
import { validateStorageVnextSearchQueries } from "./candidate-query-validation.js";

type ValidatorConfig = {
  repository: StorageVnextSearchProjectionRepository;
  transport: SearchEngineTransport;
  hydration: StorageVnextSearchHydrationPort;
  settings: SearchEngineSettings;
  documentPageSize: number;
};

type ValidationInput = Parameters<
  StorageVnextSearchProjectionPort["validateCandidate"]
>[0];

const DOCUMENT_FIELDS = [
  "id", "schemaVersion", "documentKind", "contentKind", "knowledgeBaseId",
  "sourceFilePublicId", "sourceRevisionPublicId", "logicalPath", "fileKind",
  "title", "segmentOrdinal", "headingAncestors", "searchText", "rankingTerms"
] as const;

export function createStorageVnextSearchCandidateValidator(
  config: ValidatorConfig
): Pick<StorageVnextSearchProjectionPort, "validateCandidate"> {
  return {
    validateCandidate: (input) => validateStorageVnextSearchCandidate({
      ...config,
      input
    })
  };
}

export async function validateStorageVnextSearchCandidate(input: {
  repository: StorageVnextSearchProjectionRepository;
  transport: SearchEngineTransport;
  hydration: StorageVnextSearchHydrationPort;
  settings: SearchEngineSettings;
  documentPageSize: number;
  input: ValidationInput;
}): Promise<void> {
  const config = validatorConfig(input);
  try {
    const continuation = await config.repository.beginCandidateValidation({
      candidatePublicId: config.input.candidatePublicId,
      expectedDocumentCount: config.input.expectedDocumentCount,
      documentChecksum: config.input.documentChecksum,
      schemaChecksum: config.input.schemaChecksum,
      settingsChecksum: config.input.settingsChecksum
    });
    if (continuation.outcome === "completed") return;
    const candidate = await requireCandidate(config);
    await validateProviderContract(config, candidate.providerIndexUid);
    await validateDocumentInventory(
      config,
      candidate.providerIndexUid,
      candidate.knowledgeBaseId
    );
    if (config.input.expectedDocumentCount === 0) {
      if (config.input.queryCases.length !== 0) {
        throw candidateValidationError("candidate_query_matrix_incomplete");
      }
    } else {
      await validateStorageVnextSearchQueries({
        transport: config.transport,
        hydration: config.hydration,
        indexUid: candidate.providerIndexUid,
        knowledgeBaseId: candidate.knowledgeBaseId,
        candidatePublicId: config.input.candidatePublicId,
        cases: config.input.queryCases,
        maxP95ProcessingTimeMs: config.input.maxP95ProcessingTimeMs
      });
    }
    await config.repository.completeCandidateValidation({
      candidatePublicId: config.input.candidatePublicId,
      documentChecksum: config.input.documentChecksum
    });
  } catch (error) {
    const validationError = normalizeValidationError(error);
    try {
      await config.repository.failCandidateValidation({
        candidatePublicId: config.input.candidatePublicId,
        safeErrorCode: validationError.code
      });
    } catch (convergenceError) {
      throw new AggregateError(
        [validationError, convergenceError],
        "Search candidate validation and failure convergence both failed"
      );
    }
    throw validationError;
  }
}

async function validateProviderContract(
  config: ReturnType<typeof validatorConfig>,
  indexUid: string
) {
  const provider = await config.transport.getIndex({ indexUid });
  if (!provider || provider.primaryKey !== "id") {
    throw candidateValidationError("candidate_document_invalid");
  }
  const settings = await config.transport.getSettings(indexUid);
  if (
    createStorageVnextSearchSettingsChecksum(settings)
    !== config.input.settingsChecksum
  ) throw candidateValidationError("candidate_settings_mismatch");
}

async function validateDocumentInventory(
  config: ReturnType<typeof validatorConfig>,
  indexUid: string,
  knowledgeBaseId: string
) {
  const getStats = config.transport.getIndexStats;
  const listDocuments = config.transport.listDocuments;
  if (!getStats || !listDocuments) {
    throw candidateValidationError("provider_capability_unavailable");
  }
  const stats = await getStats({ indexUid });
  if (stats.numberOfDocuments !== config.input.expectedDocumentCount) {
    throw candidateValidationError("candidate_count_mismatch");
  }
  const checksum = createStorageVnextSearchDocumentSetAccumulator();
  let offset = 0;
  let providerTotal: number | null = null;
  while (offset < stats.numberOfDocuments) {
    const page = await listDocuments({
      indexUid,
      offset,
      limit: config.documentPageSize,
      fields: DOCUMENT_FIELDS
    });
    if (
      page.offset !== offset || page.documents.length === 0
      || page.documents.length > config.documentPageSize
      || (providerTotal !== null && providerTotal !== page.total)
    ) throw candidateValidationError("candidate_count_mismatch");
    providerTotal = page.total;
    const parsed = page.documents.map((document) => parseDocument(document));
    if (parsed.some((document) =>
      document.knowledgeBaseId !== knowledgeBaseId
    )) throw candidateValidationError("candidate_document_invalid");
    await hydrateInventoryPage(config, parsed, knowledgeBaseId);
    for (const document of parsed) checksum.add(document);
    offset += parsed.length;
  }
  if (
    providerTotal !== null && providerTotal !== stats.numberOfDocuments
    || offset !== stats.numberOfDocuments
  ) throw candidateValidationError("candidate_count_mismatch");
  if (checksum.digest() !== config.input.documentChecksum) {
    throw candidateValidationError("candidate_checksum_mismatch");
  }
}

async function hydrateInventoryPage(
  config: ReturnType<typeof validatorConfig>,
  documents: ReturnType<typeof parseDocument>[],
  knowledgeBaseId: string
) {
  const sourceFilePublicIds = [...new Set(
    documents.map((document) => document.sourceFilePublicId)
  )];
  const hydrated = await config.hydration.hydrateCurrentSources({
    knowledgeBaseId,
    candidatePublicId: config.input.candidatePublicId,
    sourceFilePublicIds
  });
  try {
    assertStorageVnextSearchHydration(documents, hydrated);
  } catch {
    throw candidateValidationError("candidate_hydration_mismatch");
  }
}

function validatorConfig(input: Parameters<typeof validateStorageVnextSearchCandidate>[0]) {
  if (
    !Number.isSafeInteger(input.documentPageSize)
    || input.documentPageSize < 1 || input.documentPageSize > 1_000
  ) throw candidateValidationError("candidate_validation_failed");
  return {
    ...input
  };
}

async function requireCandidate(config: ReturnType<typeof validatorConfig>) {
  const candidate = await config.repository.getCandidate(
    config.input.candidatePublicId
  );
  if (!candidate) throw candidateValidationError("candidate_validation_failed");
  return candidate;
}

function parseDocument(document: Record<string, unknown>) {
  try {
    return parseStorageVnextSearchDocument(document);
  } catch {
    throw candidateValidationError("candidate_document_invalid");
  }
}

function normalizeValidationError(error: unknown) {
  return error instanceof StorageVnextSearchCandidateValidationError
    ? error
    : candidateValidationError("candidate_validation_failed");
}
