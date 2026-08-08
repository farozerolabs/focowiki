import { compareOkfDateOnly, normalizeOkfDateOnly } from "./dates.js";
import type {
  OkfDiagnostic,
  OkfEffectiveStatus,
  OkfOwnership
} from "./types.js";

const STATUS = new Set<OkfEffectiveStatus>(["draft", "stable", "deprecated"]);

export function analyzeOkfLifecycle(input: {
  status: unknown;
  statusPresent: boolean;
  staleAfter: unknown;
  staleAfterPresent: boolean;
  today: string;
  ownership: OkfOwnership;
}): {
  effectiveStatus: OkfEffectiveStatus | null;
  staleAfter: string | null;
  isStale: boolean | null;
  diagnostics: OkfDiagnostic[];
} {
  const diagnostics: OkfDiagnostic[] = [];
  const effectiveStatus = !input.statusPresent
    ? "stable"
    : typeof input.status === "string" && STATUS.has(input.status as OkfEffectiveStatus)
      ? input.status as OkfEffectiveStatus
      : null;
  if (input.statusPresent && effectiveStatus === null) {
    diagnostics.push(diagnostic(input.ownership, "status", "okf.status.invalid"));
  }

  const staleAfter = input.staleAfterPresent
    ? normalizeOkfDateOnly(input.staleAfter)
    : null;
  if (input.staleAfterPresent && staleAfter === null) {
    diagnostics.push(diagnostic(input.ownership, "stale_after", "okf.stale_after.invalid"));
  }
  const comparison = staleAfter === null ? null : compareOkfDateOnly(input.today, staleAfter);
  return {
    effectiveStatus,
    staleAfter,
    isStale: comparison === null ? null : comparison >= 0,
    diagnostics
  };
}

function diagnostic(
  ownership: OkfOwnership,
  path: string,
  messageKey: string
): OkfDiagnostic {
  return {
    ruleId: "OKF-0.2-LIFECYCLE",
    classification: "recommended",
    disposition: ownership === "focowiki" ? "blocking" : "advisory",
    path,
    messageKey
  };
}
