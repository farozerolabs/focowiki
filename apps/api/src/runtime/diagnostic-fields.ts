import {
  getNodeJiebaRuntimeEvidence
} from "../infrastructure/tokenization/nodejieba-tokenizer.js";
import type { RuntimeDiagnosticFields } from "../logger.js";
import { createRuntimeErrorDiagnostics } from "./error-diagnostics.js";

export function runtimeErrorFields(error: unknown): RuntimeDiagnosticFields {
  const diagnostic = createRuntimeErrorDiagnostics(error);
  return {
    errorClass: diagnostic.errorClass,
    errorCode: diagnostic.errorCode,
    errorMessage: diagnostic.errorMessage,
    stack: diagnostic.stack,
    httpStatusCode: diagnostic.httpStatusCode,
    requestId: diagnostic.requestId,
    extendedRequestId: diagnostic.extendedRequestId,
    sdkAttempts: diagnostic.sdkAttempts,
    sdkRetryDelayMs: diagnostic.sdkRetryDelayMs,
    causeClass: diagnostic.causeClass,
    causeCode: diagnostic.causeCode,
    causeMessage: diagnostic.causeMessage
  };
}

export function tokenizerDiagnosticFields(): RuntimeDiagnosticFields {
  const evidence = getNodeJiebaRuntimeEvidence();
  return {
    packageVersion: evidence.packageVersion,
    contractVersion: evidence.contractVersion,
    dictionaryDictChecksum: evidence.dictionaryChecksums.dict ?? null,
    dictionaryHmmChecksum: evidence.dictionaryChecksums.hmm ?? null,
    dictionaryUserChecksum: evidence.dictionaryChecksums.user ?? null,
    dictionaryIdfChecksum: evidence.dictionaryChecksums.idf ?? null,
    dictionaryStopWordsChecksum: evidence.dictionaryChecksums.stopWords ?? null
  };
}
