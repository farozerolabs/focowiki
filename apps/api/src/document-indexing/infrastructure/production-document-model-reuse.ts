import type {
  DocumentModelAnalysisFingerprint,
  DocumentModelEvaluationRepository
} from "../application/document-model-evaluation.js";

export async function findOrCopyDocumentModelAnalysis(input: {
  repository: DocumentModelEvaluationRepository;
  fingerprint: DocumentModelAnalysisFingerprint;
  knowledgeBaseId: string;
  sourceRevisionPublicId: string;
  modelConfigurationPublicId: string;
  modelConfigurationRevision: number;
  promptContractSha256: string;
}) {
  const exact = await input.repository.findAnalysis({
    publicId: input.fingerprint.publicId,
    knowledgeBaseId: input.knowledgeBaseId
  });
  if (exact) return exact;
  const reusable = await input.repository.findReusableAnalysis({
    knowledgeBaseId: input.knowledgeBaseId,
    modelConfigurationPublicId: input.modelConfigurationPublicId,
    modelConfigurationRevision: input.modelConfigurationRevision,
    promptContractSha256: input.promptContractSha256,
    modelInputSha256: input.fingerprint.modelInputSha256
  });
  if (!reusable) return null;
  return input.repository.storeAnalysis({
    ...input.fingerprint,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    modelConfigurationPublicId: input.modelConfigurationPublicId,
    modelConfigurationRevision: input.modelConfigurationRevision,
    promptContractSha256: input.promptContractSha256,
    result: reusable.result,
    warnings: reusable.warnings
  });
}
