import type { RuntimeConfig } from "../config.js";

type PageLimitConfig = {
  defaultPageSize: number;
  maxPageSize: number;
};

export function readPageLimit(
  rawLimit: string | undefined,
  config: RuntimeConfig,
  limits: PageLimitConfig = config.pagination
): number | null {
  if (!rawLimit) {
    return limits.defaultPageSize;
  }

  const limit = Number(rawLimit);

  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > limits.maxPageSize
  ) {
    return null;
  }

  return limit;
}

export function readTreePageLimit(
  rawLimit: string | undefined,
  config: RuntimeConfig
): number | null {
  return readPageLimit(rawLimit, config, {
    defaultPageSize: config.pagination.treeDefaultPageSize,
    maxPageSize: config.pagination.treeMaxPageSize
  });
}
