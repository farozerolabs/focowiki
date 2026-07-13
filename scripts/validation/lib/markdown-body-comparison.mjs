const REFERENCE_DEFINITION_PATTERN = /^( {0,3}\[[^\]\n]+\]:\s*)(<?[^>\s]+>?)(.*)$/u;
const INLINE_LINK_PATTERN = /(!?\[[^\]\n]*\]\()([^\s)]+)([^\n)]*\))/gu;

export function normalizeMarkdownLinkDestinations(markdown) {
  return markdown
    .split("\n")
    .map((line) => {
      const definition = line.match(REFERENCE_DEFINITION_PATTERN);
      if (definition) {
        return `${definition[1] ?? ""}<destination>${definition[3] ?? ""}`;
      }

      return line.replace(
        INLINE_LINK_PATTERN,
        (_match, prefix, _destination, suffix) => `${prefix}<destination>${suffix}`
      );
    })
    .join("\n");
}
