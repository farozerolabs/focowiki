import type {
  SearchProviderIndexDefinition,
  SearchProviderRuntime
} from "../../application/ports/search-provider-runtime.js";
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
  provider: SearchProviderRuntime;
  hydration: StorageVnextSearchHydrationPort;
  settings: SearchProviderIndexDefinition;
  documentPageSize: number;
};

type ValidationInput = Parameters<
  StorageVnextSearchProjectionPort["validateCandidate"]
>[0];

const DOCUMENT_FIELDS = [
  "id", "schemaVersion", "documentKind", "contentKind", "knowledgeBaseId",
  "sourceFilePublicId", "sourceRevisionPublicId", "logicalPath", "fileKind",
  "title", "segmentOrdinal", "headingAncestors", "searchText", "rankingTerms",
  "okfSignals"
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
  provider: SearchProviderRuntime;
  hydration: StorageVnextSearchHydrationPort;
  settings: SearchProviderIndexDefinition;
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
    await config.provider.write.refreshIndex({
      indexUid: candidate.providerIndexUid
    });
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
        query: config.provider.query,
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
  const provider = await config.provider.admin.getIndex({ indexUid });
  if (!provider || provider.primaryKey !== "id") {
    throw candidateValidationError("candidate_document_invalid");
  }
  const settings = await config.provider.admin.getIndexDefinition({ indexUid });
  if (
    !settings
    || createStorageVnextSearchSettingsChecksum(settings)
    !== config.input.settingsChecksum
  ) throw candidateValidationError("candidate_settings_mismatch");
}

async function validateDocumentInventory(
  config: ReturnType<typeof validatorConfig>,
  indexUid: string,
  knowledgeBaseId: string
) {
  const providerDocumentCount = await config.provider.validation.countDocuments({
    indexUid
  });
  if (providerDocumentCount !== config.input.expectedDocumentCount) {
    throw candidateValidationError("candidate_count_mismatch");
  }
  const checksum = createStorageVnextSearchDocumentSetAccumulator();
  let scannedDocumentCount = 0;
  let continuation: string | null = null;
  do {
    if (providerDocumentCount === 0) break;
    const page = await config.provider.validation.scanDocuments({
      indexUid,
      continuation,
      limit: config.documentPageSize,
      fields: DOCUMENT_FIELDS
    });
    if (
      page.documents.length === 0
      || page.documents.length > config.documentPageSize
    ) throw candidateValidationError("candidate_count_mismatch");
    const parsed = page.documents.map((document) => parseDocument(document));
    if (parsed.some((document) =>
      document.knowledgeBaseId !== knowledgeBaseId
    )) throw candidateValidationError("candidate_document_invalid");
    await hydrateInventoryPage(config, parsed, knowledgeBaseId);
    for (const document of parsed) checksum.add(document);
    scannedDocumentCount += parsed.length;
    if (scannedDocumentCount > providerDocumentCount) {
      throw candidateValidationError("candidate_count_mismatch");
    }
    continuation = page.continuation;
  } while (continuation !== null);
  if (
    scannedDocumentCount !== providerDocumentCount
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
  if (candidate.providerKind !== config.provider.kind) {
    throw candidateValidationError("candidate_validation_failed");
  }
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
