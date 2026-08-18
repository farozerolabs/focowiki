export function safeDocumentDiagnosticPath(
  value: string | null
): string | null {
  if (!value || value.length > 512 || /[\u0000-\u001F\u007F]/u.test(value)) {
    return null;
  }
  const encoded = value.split("/").map((segment) =>
    encodeURIComponent(segment).replace(/[!'()*]/gu, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  ).join("/");
  return encoded.length <= 512 ? encoded : null;
}
