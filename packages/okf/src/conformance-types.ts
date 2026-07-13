import type { OkfRuleId } from "./conformance-baseline.js";

export type OkfValidationProfile =
  | "normative"
  | "recommended"
  | "focowiki_quality"
  | "focowiki_extension";

export type OkfConformanceIssue = {
  ruleId: OkfRuleId;
  profile: OkfValidationProfile;
  path: string;
  message: string;
};

export function createConformanceIssue(
  ruleId: OkfRuleId,
  profile: OkfValidationProfile,
  path: string,
  message: string
): OkfConformanceIssue {
  return { ruleId, profile, path, message };
}
