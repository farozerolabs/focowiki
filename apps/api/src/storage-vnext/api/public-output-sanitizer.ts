const OMIT_PUBLIC_VALUE = Symbol("omit-public-value");

const INTERNAL_PUBLIC_KEYS = new Set([
  "accesskeyid",
  "apikey",
  "authorization",
  "bucket",
  "bucketname",
  "checksum",
  "checksumsha256",
  "cleanupactionid",
  "cleanupdetails",
  "cleanupobjectkey",
  "cleanupobjectkeys",
  "contentchecksum",
  "deletionintentid",
  "generationdetails",
  "generationhistory",
  "generationkind",
  "generationpayload",
  "generationrow",
  "generationrowid",
  "generationstate",
  "indexname",
  "indexnames",
  "indexuid",
  "indexuids",
  "legacygeneration",
  "legacygenerationid",
  "manifestchecksum",
  "meiliindexuid",
  "meilitaskuid",
  "meilisearchindexuid",
  "meilisearchtaskuid",
  "objectchecksum",
  "objectid",
  "objectkey",
  "objectownerrow",
  "objectownerrows",
  "ownerrow",
  "ownerrowid",
  "ownerrows",
  "password",
  "predecessorgenerationid",
  "providertaskuid",
  "publicationgenerationid",
  "releaseid",
  "reservationid",
  "rootpublicid",
  "s3objectkey",
  "secret",
  "secretaccesskey",
  "shardpublicid",
  "storagekey",
  "storageprefix",
  "tablename",
  "tableid",
  "tableidentifier",
  "taskid",
  "taskname",
  "taskuid",
  "taskuids",
  "token"
]);

const INTERNAL_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b((?:s3)?object[\s_-]*(?:id|key|checksum)|storage[\s_-]*(?:key|prefix)|bucket(?:[\s_-]*name)?|(?:content|manifest)?checksum(?:[\s_-]*sha256)?|(?:meili(?:search)?[\s_-]*)?index[\s_-]*(?:uid|name)|(?:meili(?:search)?[\s_-]*)?task[\s_-]*(?:uid|name|id)|table[\s_-]*(?:name|id|identifier)|owner[\s_-]*row(?:[\s_-]*id)?|lease(?:[\s_-]*(?:id|token|owner|row))?|(?:legacy[\s_-]*)?generation[\s_-]*(?:details|history|kind|payload|row|state)|predecessor[\s_-]*generation[\s_-]*id|cleanup[\s_-]*(?:action[\s_-]*id|details|object[\s_-]*keys?)|deletion[\s_-]*intent[\s_-]*id)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)`,
  "giu"
);

export function sanitizeStorageVnextPublicValue(value: unknown): unknown {
  const sanitized = sanitizeValue(value);
  return sanitized === OMIT_PUBLIC_VALUE ? null : sanitized;
}

export function sanitizeStorageVnextPublicRecord(
  value: Record<string, unknown>
): Record<string, unknown> {
  const sanitized = sanitizeValue(value);
  return isRecord(sanitized) ? sanitized : {};
}

function sanitizeValue(value: unknown): unknown | typeof OMIT_PUBLIC_VALUE {
  if (value === undefined) return OMIT_PUBLIC_VALUE;
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return sanitizePublicText(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const sanitized = sanitizeValue(item);
      return sanitized === OMIT_PUBLIC_VALUE ? [] : [sanitized];
    });
  }
  if (!isRecord(value)) return OMIT_PUBLIC_VALUE;

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nestedValue]) => {
      if (isInternalPublicKey(key)) return [];
      const sanitized = sanitizeValue(nestedValue);
      return sanitized === OMIT_PUBLIC_VALUE ? [] : [[key, sanitized]];
    })
  );
}

function isInternalPublicKey(key: string): boolean {
  const canonical = canonicalKey(key);
  return INTERNAL_PUBLIC_KEYS.has(canonical)
    || canonical.startsWith("lease")
    || canonical.startsWith("cleanup")
    || canonical.startsWith("legacygeneration")
    || canonical.startsWith("ownerrow")
    || /^generation(?:details|history|kind|payload|row|state)/u.test(canonical)
    || /^(?:active|candidate|search)index(?:uid|name)$/u.test(canonical);
}

function sanitizePublicText(value: string): string {
  return value
    .replace(INTERNAL_ASSIGNMENT_PATTERN, "$1=[redacted]")
    .replace(/\bs3:\/\/[^\s)\]}]+/giu, "[redacted-url]")
    .replace(/\bhttps?:\/\/[^\s/]*\.s3(?:[.-][^\s/]*)?\/[^\s)\]}]*/giu, "[redacted-url]")
    .replace(/\bfile:\/\/\/[^\s)\]}]+/giu, "[redacted-path]")
    .replace(/(^|[\s'"(:])\/(?:Users|home|tmp|private|var|opt|usr|dev|etc|Volumes)(?:\/[^\s)'":\]]+)+/gimu, "$1[redacted-path]")
    .replace(/(?:^|\/)knowledge-bases\/[^/\s]+\/(?:uploads|releases)\/[^\s)\]}]*/giu, "[redacted-key]")
    .replace(/\bfocowiki\.[a-z_][a-z0-9_]*\b/giu, "[redacted-table]");
}

function canonicalKey(value: string): string {
  return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
