import {
  analyzeOkfMetadata,
  inspectOkfMarkdownFile,
  parseUploadedMarkdownSource,
  type OkfDiagnostic
} from "@focowiki/okf";

export function validateDocumentOkfMarkdownMetadata(input: {
  logicalPath: string;
  kind: string;
  body: string;
}): readonly OkfDiagnostic[] {
  const profiles = input.kind === "source"
    ? ["normative", "recommended"] as const
    : [
        "normative",
        "recommended",
        "focowiki_quality",
        "focowiki_extension"
      ] as const;
  const conformanceIssues = profiles.flatMap((profile) =>
    inspectOkfMarkdownFile({
      path: input.logicalPath,
      content: input.body
    }, profile));
  const blockingConformance = conformanceIssues.find((issue) =>
    issue.disposition === "blocking");
  if (blockingConformance) {
    throw metadataValidationError(blockingConformance.ruleId, input.logicalPath);
  }
  const basename = input.logicalPath.split("/").at(-1) ?? "";
  if (basename === "index.md" || basename === "log.md") return [];
  const parsed = parseUploadedMarkdownSource({
    fileName: basename,
    content: input.body
  });
  const analysis = analyzeOkfMetadata(parsed.metadata, {
    ownership: "source",
    markdownBody: parsed.body
  });
  const blockingDiagnostic = analysis.diagnostics.find((diagnostic) =>
    diagnostic.disposition === "blocking");
  if (blockingDiagnostic) {
    throw metadataValidationError(blockingDiagnostic.ruleId, input.logicalPath);
  }
  return analysis.diagnostics;
}

function metadataValidationError(
  ruleId: string,
  resourcePath: string
): Error & { code: string; resourcePath: string } {
  const normalizedRuleId = ruleId.replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "").slice(0, 80);
  const code = `generated_okf_metadata_invalid_${normalizedRuleId || "unknown"}`;
  return Object.assign(new Error("Generated OKF metadata is invalid"), {
    code,
    resourcePath
  });
}
