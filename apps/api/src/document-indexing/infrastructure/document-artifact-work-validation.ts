import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";

export function artifactWorkTransaction<T>(
  sql: DatabaseClient,
  callback: (transactionSql: TransactionSql) => Promise<T>
): Promise<T> {
  return typeof sql.begin === "function"
    ? sql.begin(callback as never) as Promise<T>
    : callback(sql as unknown as TransactionSql);
}

export function validateArtifactWorkReceipt(input: {
  kind: string;
  key: string;
  inputFingerprintSha256: string;
  outputFingerprintSha256: string;
  value: Readonly<Record<string, unknown>>;
}): void {
  validateArtifactWorkSha256(input.inputFingerprintSha256);
  validateArtifactWorkSha256(input.outputFingerprintSha256);
  if (Buffer.byteLength(input.key, "utf8") > 1_024
    || Buffer.byteLength(JSON.stringify(input.value), "utf8") > 131_072) {
    throw artifactWorkError("receipt_too_large");
  }
}

export function validateArtifactWorkSafeError(
  code: string,
  message: string | null
): void {
  if (!code || Buffer.byteLength(code, "utf8") > 128
    || (message !== null && Buffer.byteLength(message, "utf8") > 2_048)) {
    throw artifactWorkError("invalid_error");
  }
}

export function validateArtifactWorkSha256(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw artifactWorkError("invalid_fingerprint");
  }
  return value;
}

export function validateArtifactWorkIdentity(value: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 255) {
    throw artifactWorkError("invalid_identity");
  }
}

export function validateArtifactWorkPositiveInteger(
  value: number,
  name: string,
  maximum = 1_000
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw artifactWorkError(`invalid_${name}`);
  }
}

export function validateArtifactWorkTimestamp(value: string): void {
  if (new Date(value).toISOString() !== value) {
    throw artifactWorkError("invalid_timestamp");
  }
}

function artifactWorkError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document artifact work error: ${code}`), {
    code
  });
}
