export function assertRepositoryIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 255) {
    throw repositoryContractError(`invalid_${field}`);
  }
  return normalized;
}

export function assertRepositorySha256(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw repositoryContractError(`invalid_${field}`);
  }
  return value;
}

export function assertRepositoryTimestamp(value: string, field: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw repositoryContractError(`invalid_${field}`);
  return new Date(time).toISOString();
}

export function assertRepositoryPositiveInteger(
  value: number,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw repositoryContractError(`invalid_${field}`);
  }
  return value;
}

export function uniqueBoundedStrings(
  values: readonly string[],
  field: string,
  maximumItems: number,
  maximumBytes: number
): string[] {
  if (values.length > maximumItems) {
    throw repositoryContractError(`invalid_${field}`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.normalize("NFKC").trim();
    if (!normalized) continue;
    if (Buffer.byteLength(normalized, "utf8") > maximumBytes) {
      throw repositoryContractError(`invalid_${field}`);
    }
    const key = normalized.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function repositoryContractError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document repository contract error: ${code}`), {
    code
  });
}
