const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function buildDeveloperOpenApiInventory(document) {
  const items = [];
  const schemas = document?.components?.schemas ?? {};

  for (const [routePath, pathItem] of Object.entries(document?.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method) || !operation?.operationId) continue;
      const operationId = operation.operationId;
      add(items, {
        id: `openapi:operation:${operationId}`,
        kind: "operation",
        operationId,
        method: method.toUpperCase(),
        path: routePath
      });
      const operationSlug = toKebabCase(operationId);
      for (const locale of ["en", "zh-CN"]) {
        const source = locale === "en"
          ? `docs/openapi/operations/${operationSlug}.md`
          : `docs/zh-CN/openapi/operations/${operationSlug}.md`;
        add(items, {
          id: `openapi:documentation:${operationId}:${locale}`,
          kind: "documentation",
          operationId,
          locale,
          source
        });
      }
      add(items, {
        id: `openapi:swagger-entry:${operationId}`,
        kind: "swagger-entry",
        operationId,
        source: "docs/openapi/explorer.md"
      });

      for (const [index, security] of (operation.security ?? document.security ?? []).entries()) {
        add(items, {
          id: `openapi:security:${operationId}:${index}`,
          kind: "security",
          operationId,
          value: security
        });
      }

      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
      for (const [index, unresolved] of parameters.entries()) {
        const parameter = resolveReference(unresolved, document);
        const name = parameter?.name ?? `parameter-${index}`;
        add(items, {
          id: `openapi:parameter:${operationId}:${parameter?.in ?? "unknown"}:${name}`,
          kind: "parameter",
          operationId,
          location: parameter?.in ?? null,
          name,
          required: Boolean(parameter?.required)
        });
        walkSchema({
          schema: parameter?.schema,
          document,
          schemas,
          items,
          operationId,
          kind: "parameter-field",
          pointer: `${parameter?.in ?? "unknown"}.${name}`
        });
      }

      for (const [mediaType, media] of Object.entries(operation.requestBody?.content ?? {})) {
        walkSchema({
          schema: media?.schema,
          document,
          schemas,
          items,
          operationId,
          kind: "request-field",
          pointer: `request.${mediaType}`
        });
      }

      for (const [status, unresolvedResponse] of Object.entries(operation.responses ?? {})) {
        const response = resolveReference(unresolvedResponse, document);
        add(items, {
          id: `openapi:response-status:${operationId}:${status}`,
          kind: "response-status",
          operationId,
          status,
          description: response?.description ?? ""
        });
        for (const [headerName, unresolvedHeader] of Object.entries(response?.headers ?? {})) {
          const header = resolveReference(unresolvedHeader, document);
          add(items, {
            id: `openapi:response-header:${operationId}:${status}:${headerName}`,
            kind: "response-header",
            operationId,
            status,
            name: headerName,
            required: Boolean(header?.required)
          });
        }
        for (const [mediaType, media] of Object.entries(response?.content ?? {})) {
          walkSchema({
            schema: media?.schema,
            document,
            schemas,
            items,
            operationId,
            kind: "response-field",
            pointer: `response.${status}.${mediaType}`
          });
        }
      }

      walkExamples(operation, `operation.${operationId}`, operationId, items);
    }
  }

  return items.map((item) => ({
    ...item,
    source: item.source ?? "docs/public/openapi/focowiki-openapi.json",
    manualRequired: true
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function walkSchema({ schema, document, items, operationId, kind, pointer, seen = new Set() }) {
  if (!schema || typeof schema !== "object") return;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return;
    const nextSeen = new Set(seen).add(schema.$ref);
    walkSchema({
      schema: resolveReference(schema, document),
      document,
      items,
      operationId,
      kind,
      pointer,
      seen: nextSeen
    });
    return;
  }

  add(items, {
    id: `openapi:${kind}:${operationId}:${pointer}`,
    kind,
    operationId,
    pointer,
    type: schema.type ?? null,
    nullable: Boolean(schema.nullable)
  });
  for (const rule of ["enum", "const", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "additionalProperties"]) {
    if (schema[rule] !== undefined) {
      add(items, {
        id: `openapi:schema-rule:${operationId}:${pointer}:${rule}`,
        kind: "schema-rule",
        operationId,
        pointer,
        rule,
        value: schema[rule]
      });
    }
  }
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    walkSchema({
      schema: property,
      document,
      items,
      operationId,
      kind,
      pointer: `${pointer}.${name}`,
      seen
    });
  }
  if (schema.items) {
    walkSchema({
      schema: schema.items,
      document,
      items,
      operationId,
      kind,
      pointer: `${pointer}[]`,
      seen
    });
  }
  for (const [index, branch] of [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])].entries()) {
    walkSchema({
      schema: branch,
      document,
      items,
      operationId,
      kind,
      pointer: `${pointer}.variant-${index}`,
      seen
    });
  }
}

function walkExamples(value, pointer, operationId, items) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}.${key}`;
    if (key === "example" || key === "examples") {
      add(items, {
        id: `openapi:example:${operationId}:${childPointer}`,
        kind: "example",
        operationId,
        pointer: childPointer
      });
      continue;
    }
    walkExamples(child, childPointer, operationId, items);
  }
}

function resolveReference(value, document) {
  if (!value?.$ref) return value;
  return value.$ref
    .replace(/^#\//u, "")
    .split("/")
    .reduce((current, segment) => current?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")], document);
}

function add(items, item) {
  if (items.some((existing) => existing.id === item.id)) return;
  items.push(item);
}

function toKebabCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
}
