import { isHumanOkfActor } from "./actors.js";
import { normalizeOkfDateTime } from "./dates.js";
import type {
  OkfDiagnostic,
  OkfOwnership,
  OkfTrustTier,
  OkfVerificationEvent
} from "./types.js";

export type OkfVerificationResult = {
  events: OkfVerificationEvent[] | null;
  trustTier: OkfTrustTier | null;
  latestVerifiedAt: string | null;
  diagnostics: OkfDiagnostic[];
};

export function analyzeOkfVerification(input: {
  value: unknown;
  present: boolean;
  ownership: OkfOwnership;
}): OkfVerificationResult {
  if (!input.present) {
    return {
      events: [],
      trustTier: "unverified",
      latestVerifiedAt: null,
      diagnostics: []
    };
  }
  const candidates = Array.isArray(input.value) ? input.value : [input.value];
  const events: OkfVerificationEvent[] = [];
  for (const value of candidates) {
    if (!isRecord(value)) return invalid(input.ownership);
    const at = normalizeOkfDateTime(value.at);
    if (typeof value.by !== "string" || value.by.length === 0 || at === null) {
      return invalid(input.ownership);
    }
    events.push({ ...value, by: value.by, at });
  }
  if (events.length === 0) return invalid(input.ownership);
  const latestVerifiedAt = events
    .map((event) => event.at)
    .sort()
    .at(-1) ?? null;
  return {
    events,
    trustTier: events.some((event) => isHumanOkfActor(event.by))
      ? "human-reviewed"
      : "machine-confirmed",
    latestVerifiedAt,
    diagnostics: []
  };
}

function invalid(ownership: OkfOwnership): OkfVerificationResult {
  return {
    events: null,
    trustTier: null,
    latestVerifiedAt: null,
    diagnostics: [{
      ruleId: "OKF-0.2-VERIFICATION",
      classification: "recommended",
      disposition: ownership === "focowiki" ? "blocking" : "advisory",
      path: "verified",
      messageKey: "okf.verified.invalid"
    }]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
