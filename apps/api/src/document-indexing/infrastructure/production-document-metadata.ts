export function metadataAliases(
  metadata: Readonly<Record<string, unknown>>
): string[] {
  const values: unknown[] = [];
  for (const key of ["aliases", "alternate_names", "alternateNames"]) {
    const value = metadata[key];
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) values.push(...value);
  }
  return [...new Set(values.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim()))].slice(0, 255);
}
