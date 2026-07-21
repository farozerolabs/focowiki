import type { ChangeFactKind } from "../domain/generation.js";
import {
  planPublicationImpacts,
  type ImpactPlannerConfig,
  type PublicationImpact
} from "./impact-planner.js";

export type PublicationImpactPlanningFact = {
  id: string;
  kind: ChangeFactKind;
  sourceFileId: string | null;
  previousPath: string | null;
  path: string | null;
  graphNeighborSourceFileIds: string[];
  graphEdgeIds: string[];
  removedGraphEdgeIds: string[];
  preplannedImpacts?: PublicationImpact[] | undefined;
  impactPlanner: ImpactPlannerConfig | null;
};

export type PublicationImpactCauseRow = {
  ordinal: number;
  changeFactId: string;
  impact: PublicationImpact;
};

export type PublicationImpactBatch = {
  plannedFacts: Array<{
    fact: PublicationImpactPlanningFact;
    impacts: PublicationImpact[];
  }>;
  causeRows: PublicationImpactCauseRow[];
  effectiveImpacts: PublicationImpact[];
};

export function planPublicationImpactBatch(
  facts: readonly PublicationImpactPlanningFact[]
): PublicationImpactBatch {
  const effective = new Map<string, PublicationImpact>();
  const causeRows: PublicationImpactCauseRow[] = [];
  let ordinal = 0;
  const plannedFacts = facts.map((fact) => {
    const impacts = resolveFactImpacts(fact);
    for (const impact of impacts) {
      ordinal += 1;
      effective.set(projectionTargetKey(impact), impact);
      causeRows.push({ ordinal, changeFactId: fact.id, impact });
    }
    return { fact, impacts };
  });

  return {
    plannedFacts,
    causeRows,
    effectiveImpacts: [...effective.values()].sort(compareImpacts)
  };
}

function resolveFactImpacts(fact: PublicationImpactPlanningFact): PublicationImpact[] {
  if (fact.preplannedImpacts) return fact.preplannedImpacts;
  if (!fact.impactPlanner) {
    throw new Error("Publication change fact planning context is unavailable");
  }
  return planPublicationImpacts({
    changeFactId: fact.id,
    kind: fact.kind,
    sourceFileId: fact.sourceFileId,
    previousPath: fact.previousPath,
    path: fact.path,
    graphNeighborSourceFileIds: fact.graphNeighborSourceFileIds,
    graphEdgeIds: fact.graphEdgeIds,
    removedGraphEdgeIds: fact.removedGraphEdgeIds,
    config: fact.impactPlanner
  });
}

function projectionTargetKey(impact: PublicationImpact): string {
  return `${impact.projectionKind}\u0000${impact.projectionKey}\u0000${impact.recordIdentity}`;
}

function compareImpacts(left: PublicationImpact, right: PublicationImpact): number {
  return left.projectionKind.localeCompare(right.projectionKind, "en")
    || left.projectionKey.localeCompare(right.projectionKey, "en")
    || left.recordIdentity.localeCompare(right.recordIdentity, "en");
}
