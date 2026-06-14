const LEGACY_GENERATED_MARKDOWN_NAME = /^([0-9a-f]{32})-(.+)-([0-9a-f]{12})\.md$/i;
const LEGACY_GENERATED_MARKDOWN_REFERENCE = /\b[0-9a-f]{32}-(.+?)-[0-9a-f]{12}\.md\b/gi;

export function formatDisplayFileName(fileName: string) {
  const match = LEGACY_GENERATED_MARKDOWN_NAME.exec(fileName);

  if (!match?.[2]) {
    return fileName;
  }

  return `${match[2]}.md`;
}

export function formatDisplayFileReference(value: string) {
  return value.replace(
    LEGACY_GENERATED_MARKDOWN_REFERENCE,
    (_match, fileName: string) => `${fileName}.md`
  );
}
