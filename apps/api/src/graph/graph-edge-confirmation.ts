import {
  requestGraphRelationshipConfirmations,
  type OkfGraphEdge,
  type OkfGraphNode
} from "@focowiki/okf";
import type { GraphModelConfirmationOptions } from "./graph-types.js";
import { stripGeneratedSections } from "./content-profile.js";
import {
  createRejectedEdge,
  isConfirmableRelationType,
  isSafeLocalFallbackEdge,
  isStrongSharedPhraseOnlyEdge
} from "./graph-edge-scoring.js";

export async function confirmGraphEdges(input: {
  node: OkfGraphNode;
  body: string;
  candidates: OkfGraphNode[];
  edges: OkfGraphEdge[];
  modelConfirmation: GraphModelConfirmationOptions | null;
}): Promise<{ edges: OkfGraphEdge[]; rejectedEdges: OkfGraphEdge[]; warnings: string[] }> {
  if (input.edges.length === 0) {
    return {
      edges: [],
      rejectedEdges: [],
      warnings: []
    };
  }

  if (!input.modelConfirmation) {
    return splitSafeLocalEdges(input.edges);
  }

  const confirmationCandidates = input.edges.filter(isModelConfirmationCandidateEdge);
  const locallyRejectedEdges = input.edges
    .filter((edge) => !isModelConfirmationCandidateEdge(edge))
    .map((edge) =>
      createRejectedEdge(edge, "The local signal was not strong enough for model confirmation.")
    );

  if (confirmationCandidates.length === 0) {
    return {
      edges: [],
      rejectedEdges: locallyRejectedEdges,
      warnings: []
    };
  }

  const result = await requestGraphRelationshipConfirmations({
    client: input.modelConfirmation.client,
    modelName: input.modelConfirmation.modelName,
    contextWindowTokens: input.modelConfirmation.contextWindowTokens,
    receiveTimeouts: input.modelConfirmation.receiveTimeouts,
    currentFile: input.node,
    body: stripGeneratedSections(input.body),
    candidates: confirmationCandidates,
    candidateFiles: listEdgeCandidateFiles(input.candidates, confirmationCandidates)
  });

  if (result.confirmations.length === 0) {
    const hasModelDecision = result.warnings.length === 0;
    const allowLocalFallback = !hasUnsafeModelOutputWarning(result.warnings);

    return {
      edges: hasModelDecision || !allowLocalFallback ? [] : confirmationCandidates.filter(isSafeLocalFallbackEdge),
      rejectedEdges: [
        ...locallyRejectedEdges,
        ...(hasModelDecision || !allowLocalFallback
          ? confirmationCandidates.map((edge) =>
              createRejectedEdge(edge, "The model did not accept this candidate relationship.")
            )
          : confirmationCandidates
              .filter((edge) => !isSafeLocalFallbackEdge(edge))
              .map((edge) =>
                createRejectedEdge(edge, "The model confirmation failed and the local signal was not strong enough.")
              ))
      ],
      warnings: result.warnings
    };
  }

  const confirmationByTarget = new Map(
    result.confirmations.map((confirmation) => [confirmation.targetFileId, confirmation])
  );
  const acceptedEdges: OkfGraphEdge[] = [];
  const rejectedEdges: OkfGraphEdge[] = [...locallyRejectedEdges];

  for (const edge of confirmationCandidates) {
    const confirmation = confirmationByTarget.get(edge.toFileId);

    if (!confirmation) {
      rejectedEdges.push(createRejectedEdge(edge, "The model did not return this candidate relationship."));
      continue;
    }

    if (!confirmation.accepted) {
      rejectedEdges.push(createRejectedEdge(edge, confirmation.reason));
      continue;
    }

    if (confirmation.relationType !== edge.relationType) {
      rejectedEdges.push(
        createRejectedEdge(edge, "The model returned a different relationship type than the candidate.")
      );
      continue;
    }

    acceptedEdges.push({
      ...edge,
      relationType: edge.relationType,
      weight: Math.max(edge.weight, confirmation.weight),
      reason: confirmation.reason.trim() || edge.reason,
      source: "model_confirmed",
      evidence: {
        ...(edge.evidence ?? {}),
        deterministicSource: edge.source,
        deterministicRelationType: edge.relationType
      }
    });
  }

  return {
    edges: acceptedEdges,
    rejectedEdges,
    warnings: result.warnings
  };
}

function splitSafeLocalEdges(edges: OkfGraphEdge[]): {
  edges: OkfGraphEdge[];
  rejectedEdges: OkfGraphEdge[];
  warnings: string[];
} {
  const accepted = edges.filter(isSafeLocalFallbackEdge);
  return {
    edges: accepted,
    rejectedEdges: edges
      .filter((edge) => !isSafeLocalFallbackEdge(edge))
      .map((edge) =>
        createRejectedEdge(edge, "The local evidence was not specific enough without model review.")
      ),
    warnings: []
  };
}

function isModelConfirmationCandidateEdge(edge: OkfGraphEdge): boolean {
  if (edge.relationType === "same_specific_subject" && !isStrongSharedPhraseOnlyEdge(edge)) {
    return false;
  }

  return isConfirmableRelationType(edge.relationType);
}

function hasUnsafeModelOutputWarning(warnings: string[]): boolean {
  return warnings.some((warning) =>
    /local schema validation|incomplete|did not complete|refused/i.test(warning)
  );
}

function listEdgeCandidateFiles(candidates: OkfGraphNode[], edges: OkfGraphEdge[]): OkfGraphNode[] {
  const edgeTargetIds = new Set(edges.map((edge) => edge.toFileId));

  return candidates.filter((candidate) => edgeTargetIds.has(candidate.fileId));
}
