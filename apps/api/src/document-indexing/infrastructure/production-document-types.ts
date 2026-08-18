import type { SemanticDesiredFactSet } from
  "../../semantic/domain/contracts.js";
import type { ModelSuggestions } from "@focowiki/okf";
import type { SourceContentProfile } from "../../graph/content-profile.js";
import type { DocumentModelEvaluationExecution } from
  "../application/document-model-evaluation.js";
import { createDocumentSemanticPlan } from
  "../application/document-semantic-plan.js";
import { createDocumentSourcePreparation } from
  "../application/document-source-preparation.js";

export type PreparedDocument = Awaited<ReturnType<ReturnType<
  typeof createDocumentSourcePreparation
>>> & {
  sourceLinkBaseLogicalPath: string;
  context: {
    source: {
      objectId: string;
      resourceRevision: number;
      checksumSha256: string;
      byteCount: number;
      contentType: string;
      logicalPath: string;
      normalizedPath: string;
      title: string;
      metadata: Readonly<Record<string, unknown>>;
    };
    runtimeSettings: Readonly<Record<string, unknown>>;
  };
};

export type SemanticDocument = {
  plan: ReturnType<ReturnType<typeof createDocumentSemanticPlan>>;
  desiredFacts: SemanticDesiredFactSet;
  suggestions: ModelSuggestions | null;
  contentProfile: SourceContentProfile;
  modelExecution: DocumentModelEvaluationExecution | null;
  warnings: readonly string[];
};
