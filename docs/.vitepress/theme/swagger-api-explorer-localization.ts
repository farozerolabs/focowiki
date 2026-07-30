type SwaggerExplorerLocaleCopy = {
  descriptions: Record<string, string>;
  fieldDescriptions: Record<string, string>;
  operationDescriptions: Record<string, string>;
  operationSummaries: Record<string, string>;
  successResponseDescriptions: Record<string, string>;
  tagLabels: Record<string, string>;
};

const operationMethods = new Set(["get", "post", "put", "patch", "delete"]);

export function localizeSwaggerSpec(
  spec: Record<string, unknown>,
  copy?: SwaggerExplorerLocaleCopy
): Record<string, unknown> {
  if (!copy) {
    return spec;
  }

  const localized = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  localizeDescriptions(localized, copy);
  localizeTags(localized, copy);
  localizeOperations(localized, copy);
  return localized;
}

function localizeTags(
  spec: Record<string, unknown>,
  copy: SwaggerExplorerLocaleCopy
) {
  if (!Array.isArray(spec.tags)) {
    return;
  }
  for (const tagValue of spec.tags) {
    const tag = readRecord(tagValue);
    const name = readString(tag.name);
    if (copy.tagLabels[name]) {
      tag.name = copy.tagLabels[name];
    }
  }
}

function localizeOperations(
  spec: Record<string, unknown>,
  copy: SwaggerExplorerLocaleCopy
) {
  for (const pathItemValue of Object.values(readRecord(spec.paths))) {
    const pathItem = readRecord(pathItemValue);
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!operationMethods.has(method.toLowerCase())) {
        continue;
      }
      const operation = readRecord(operationValue);
      const operationId = readString(operation.operationId);
      operation.summary =
        copy.operationSummaries[operationId] ?? operation.summary;
      operation.description =
        copy.operationDescriptions[operationId] ?? operation.description;
      if (Array.isArray(operation.tags)) {
        operation.tags = operation.tags.map((tag) =>
          typeof tag === "string" ? (copy.tagLabels[tag] ?? tag) : tag
        );
      }
      localizeNamedDescriptions(operation.parameters, copy);
      localizeSuccessResponses(operation.responses, operationId, copy);
    }
  }
}

function localizeNamedDescriptions(
  values: unknown,
  copy: SwaggerExplorerLocaleCopy
) {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    const item = readRecord(value);
    const name = readString(item.name);
    const description = readString(item.description);
    item.description =
      copy.descriptions[description] ??
      (description || copy.fieldDescriptions[name]) ??
      item.description;
  }
}

function localizeSuccessResponses(
  responsesValue: unknown,
  operationId: string,
  copy: SwaggerExplorerLocaleCopy
) {
  const successDescription = copy.successResponseDescriptions[operationId];
  if (!successDescription) {
    return;
  }
  for (const [status, responseValue] of Object.entries(
    readRecord(responsesValue)
  )) {
    if (/^2\d\d$/.test(status)) {
      readRecord(responseValue).description = successDescription;
    }
  }
}

function localizeDescriptions(
  value: unknown,
  copy: SwaggerExplorerLocaleCopy,
  fieldName?: string
) {
  if (Array.isArray(value)) {
    for (const item of value) {
      localizeDescriptions(item, copy, fieldName);
    }
    return;
  }
  const record = readRecord(value);
  if (Object.keys(record).length === 0) {
    return;
  }

  const description = readString(record.description);
  if (description) {
    record.description =
      copy.descriptions[description] ??
      (fieldName ? copy.fieldDescriptions[fieldName] : undefined) ??
      description;
  }

  for (const [key, child] of Object.entries(record)) {
    if (key === "properties") {
      for (const [propertyName, property] of Object.entries(readRecord(child))) {
        localizeDescriptions(property, copy, propertyName);
      }
      continue;
    }
    localizeDescriptions(child, copy);
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
