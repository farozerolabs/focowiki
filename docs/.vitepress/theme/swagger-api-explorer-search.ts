const operationMethods = new Set(["get", "post", "put", "patch", "delete"]);

export type SwaggerOperationSearchResult = {
  fragment: string;
  method: string;
  operationId: string;
  path: string;
  summary: string;
  tag: string;
};

export function searchSwaggerOperations(
  spec: Record<string, unknown>,
  query: string
): SwaggerOperationSearchResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const paths = readRecord(spec.paths);
  const results: SwaggerOperationSearchResult[] = [];

  for (const [operationPath, pathItemValue] of Object.entries(paths)) {
    const pathItem = readRecord(pathItemValue);
    for (const [method, operationValue] of Object.entries(pathItem)) {
      const normalizedMethod = method.toLocaleLowerCase();
      if (!operationMethods.has(normalizedMethod)) {
        continue;
      }

      const operation = readRecord(operationValue);
      const operationId = readString(operation.operationId);
      const tags = readStringArray(operation.tags);
      const searchableText = [
        normalizedMethod,
        operationPath,
        operationId,
        readString(operation.summary),
        readString(operation.description),
        ...tags
      ]
        .join(" ")
        .toLocaleLowerCase();

      if (!searchableText.includes(normalizedQuery)) {
        continue;
      }

      const primaryTag = tags[0] ?? "default";
      results.push({
        fragment: `#/${encodeURIComponent(primaryTag)}/${encodeURIComponent(operationId)}`,
        method: normalizedMethod.toUpperCase(),
        operationId,
        path: operationPath,
        summary: readString(operation.summary) || operationId || operationPath,
        tag: primaryTag
      });
    }
  }

  return results.sort((left, right) =>
    `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`)
  );
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
