export function resolveDocumentProjectionOwnerVersion(input: {
  scopeOutputVersion: number | undefined;
  manifestVersion: number | undefined;
}): number | undefined {
  return input.scopeOutputVersion ?? input.manifestVersion;
}
