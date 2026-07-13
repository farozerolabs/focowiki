export type GeneratedCitation = {
  label: string;
  target: string;
};

export function renderGeneratedCitations(citations: GeneratedCitation[]): string[] {
  const safe = citations
    .map((citation) => ({
      label: cleanLabel(citation.label),
      target: citation.target.trim()
    }))
    .filter((citation) => citation.label && isSafeCitationTarget(citation.target));

  if (safe.length === 0) {
    return [];
  }

  return [
    "",
    "# Citations",
    "",
    ...safe.map((citation, index) =>
      `[${index + 1}] [${escapeMarkdownLabel(citation.label)}](${citation.target})`
    )
  ];
}

function cleanLabel(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function escapeMarkdownLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function isSafeCitationTarget(value: string): boolean {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
    return false;
  }
  if (value.startsWith("/")) {
    return !value.includes("\\") && !value.split("/").includes("..");
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
