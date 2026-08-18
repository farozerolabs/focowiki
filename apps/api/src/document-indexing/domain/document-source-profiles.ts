import { resolveSourceMarkdownLinkDestination } from "@focowiki/okf";

export type DocumentStructureProfile = {
  schemaVersion: "document-structure-profile-v1";
  headings: Array<{ level: number; text: string }>;
  lineCount: number;
  characterCount: number;
};

export type DocumentReferenceProfile = {
  schemaVersion: "document-reference-profile-v1";
  references: Array<{
    label: string;
    rawTarget: string;
    resolvedTarget: string;
    startOffset: number;
    endOffset: number;
  }>;
};

export function buildDocumentStructureProfile(body: string): DocumentStructureProfile {
  const headings: DocumentStructureProfile["headings"] = [];
  let activeFence: string | null = null;
  for (const line of body.split("\n")) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1] ?? null;
    if (fence) {
      if (activeFence === null) activeFence = fence[0] ?? null;
      else if (fence[0] === activeFence) activeFence = null;
      continue;
    }
    if (activeFence !== null) continue;
    const match = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u);
    const text = match?.[2]?.trim();
    if (match?.[1] && text && headings.length < 512) {
      headings.push({ level: match[1].length, text: text.slice(0, 512) });
    }
  }
  return {
    schemaVersion: "document-structure-profile-v1",
    headings,
    lineCount: body ? body.split("\n").length : 0,
    characterCount: body.length
  };
}

export function buildDocumentReferenceProfile(
  body: string,
  sourceLogicalPath: string
): DocumentReferenceProfile {
  const references: DocumentReferenceProfile["references"] = [];
  const pattern = /(?<!!)\[([^\]\n]+)\]\((<?[^\s)>\n]+>?)(?:\s+["'][^"'\n]*["'])?\)/gu;
  for (const match of body.matchAll(pattern)) {
    if (references.length >= 512) break;
    const label = match[1]?.trim() ?? "";
    const rawTarget = match[2]?.trim() ?? "";
    if (!label || !rawTarget || match.index === undefined) continue;
    references.push({
      label: label.slice(0, 512),
      rawTarget: rawTarget.slice(0, 4_096),
      resolvedTarget: resolveSourceMarkdownLinkDestination(
        rawTarget,
        sourceLogicalPath
      ).slice(0, 4_096),
      startOffset: match.index,
      endOffset: match.index + match[0].length
    });
  }
  return { schemaVersion: "document-reference-profile-v1", references };
}
