const SECRET_NAME_PATTERN =
  /(ADMIN_PASSWORD|ADMIN_SESSION_SECRET|PUBLIC_OPENAPI_KEY|OPENAPI_KEY|rawKey|S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY|MODEL_API_KEY|AUTHORIZATION|COOKIE|SESSION)/gi;

export function redactPotentialPathText(value) {
  return String(value ?? "")
    .replace(/\/[^"'`\s]*\/[^"'`\s]*/g, "<redacted-path>")
    .replace(/[A-Z]:\\[^"'`\s]*/g, "<redacted-path>")
    .replace(/(knowledge-bases\/)[^"'`\s]+/g, "$1<redacted-object-key>")
    .replace(/(uploads\/)[^"'`\s]+/g, "$1<redacted-object-key>")
    .replace(/(releases\/)[^"'`\s]+/g, "$1<redacted-object-key>")
    .replace(/(Authorization:\s*Bearer\s+)[^"'`\s]+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/g, "$1<redacted>")
    .replace(new RegExp(`(${SECRET_NAME_PATTERN.source}\\s*[:=]\\s*)[^\\s,;}"']+`, "gi"), "$1<redacted>");
}

export function redactReportText(value) {
  return redactPotentialPathText(value)
    .replace(/raw Markdown body/gi, "raw Markdown body")
    .replace(/provider-secret/gi, "<redacted>")
    .replace(/model-secret/gi, "<redacted>")
    .replace(/s3-secret/gi, "<redacted>")
    .replace(/session-secret/gi, "<redacted>");
}
