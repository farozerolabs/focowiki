import {
  analyzeOkfMetadata,
  type OkfDecisionSignals
} from "@focowiki/okf";

export function presentOkfSignals(
  metadata: Readonly<Record<string, unknown>>,
  today?: string
): OkfDecisionSignals {
  return analyzeOkfMetadata(metadata as Record<string, unknown>, {
    ownership: "source",
    ...(today === undefined ? {} : { today })
  }).signals;
}
