import type { Context } from "hono";
import type { RuntimeConfig } from "../config.js";
import { validationError, writeDeveloperOpenApiError } from "./errors.js";

export async function safe(
  context: Context,
  action: () => Promise<unknown> | unknown,
  status = 200
): Promise<Response> {
  try {
    return context.json(await action(), status as never);
  } catch (error) {
    return writeDeveloperOpenApiError(context, error);
  }
}

export function readLimit(
  value: string | undefined,
  config: RuntimeConfig,
  limits: { defaultPageSize: number; maxPageSize: number } = config.pagination
): number {
  const parsed = value ? Number(value) : limits.defaultPageSize;

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > limits.maxPageSize) {
    throw validationError("Pagination limit is invalid.", { field: "limit" });
  }

  return parsed;
}
