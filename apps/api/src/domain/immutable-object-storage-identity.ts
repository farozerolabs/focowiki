export const IMMUTABLE_CHECKSUM_METADATA_KEY = "focowiki-checksum-sha256";
export const IMMUTABLE_FORMAT_METADATA_KEY = "focowiki-format-version";

export function matchesImmutableStorageIdentity(
  stored: {
    contentType: string | null;
    sizeBytes: number;
    metadata: Record<string, string>;
  },
  expected: {
    checksumSha256: string;
    formatVersion: number;
    contentType: string;
    sizeBytes: number;
  }
): boolean {
  return stored.sizeBytes === expected.sizeBytes
    && stored.contentType === expected.contentType
    && stored.metadata[IMMUTABLE_CHECKSUM_METADATA_KEY] === expected.checksumSha256
    && stored.metadata[IMMUTABLE_FORMAT_METADATA_KEY] === String(expected.formatVersion);
}
