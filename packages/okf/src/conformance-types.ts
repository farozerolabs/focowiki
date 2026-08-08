import type { OkfRuleId } from "./conformance-baseline.js";

export type OkfValidationProfile =
  | "normative"
  | "recommended"
  | "focowiki_quality"
  | "focowiki_extension";

export type OkfConformanceIssue = {
  ruleId: OkfRuleId;
  profile: OkfValidationProfile;
  classification: "official_must" | "official_should" | "producer";
  disposition: "advisory" | "blocking";
  path: string;
  message: string;
};

export function createConformanceIssue(
  ruleId: OkfRuleId,
  profile: OkfValidationProfile,
  path: string,
  message: string,
  options: {
    disposition?: "advisory" | "blocking";
  } = {}
): OkfConformanceIssue {
  const classification = ruleId.startsWith("FOCOWIKI-")
    ? "producer"
    : ruleId.includes("CONCEPT-FRONTMATTER")
      || ruleId.includes("CONCEPT-TYPE")
      || ruleId.includes("RESERVED-FILENAME")
      || ruleId.includes("INDEX-STRUCTURE")
      || ruleId.includes("LOG-STRUCTURE")
      || ruleId.includes("UNKNOWN-FIELDS")
      || ruleId.includes("VERIFIED-MAPPING")
      || ruleId.includes("MISSING-OPTIONAL")
      || ruleId.includes("BROKEN-LINK-TOLERANCE")
      ? "official_must"
      : "official_should";
  return {
    ruleId,
    profile,
    classification,
    disposition: options.disposition ?? defaultDisposition(path, ruleId),
    path,
    message
  };
}

function defaultDisposition(
  path: string,
  ruleId: OkfRuleId
): "advisory" | "blocking" {
  if (ruleId.startsWith("FOCOWIKI-")) return "blocking";
  const basename = path.split("/").at(-1) ?? "";
  const sourceBacked = path.startsWith("pages/")
    && basename !== "index.md"
    && basename !== "log.md"
    && !/^index-(?!map-).+\.md$/u.test(basename);
  return sourceBacked ? "advisory" : "blocking";
}
