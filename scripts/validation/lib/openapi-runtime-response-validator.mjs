const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"]);

export function createOpenApiRuntimeResponseValidator(document) {
  const operations = collectOperations(document);
  return {
    validate(input) {
      const method = String(input.method ?? "GET").toUpperCase();
      const pathname = new URL(String(input.pathname), "http://openapi.local").pathname;
      const operation = operations.find((candidate) =>
        candidate.method === method && candidate.pattern.test(pathname)
      );
      if (!operation) {
        throw new Error(`${method} ${pathname} does not match a released OpenAPI operation.`);
      }
      const response = operation.operation.responses?.[String(input.status)]
        ?? operation.operation.responses?.default;
      if (!response) {
        throw new Error(
          `${operation.operationId} returned undocumented response status ${input.status}.`
        );
      }
      const content = response.content ?? {};
      const normalizedContentType = String(input.contentType ?? "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (Object.keys(content).length === 0) {
        if (input.body !== null && input.body !== undefined && input.body !== "") {
          throw new Error(`${operation.operationId} returned an undocumented response body.`);
        }
        return operation.operationId;
      }
      const media = content[normalizedContentType]
        ?? (normalizedContentType.endsWith("+json") ? content["application/json"] : null);
      if (!media) {
        throw new Error(
          `${operation.operationId} returned undocumented content type ${normalizedContentType || "<empty>"}.`
        );
      }
      validateSchema(document, media.schema ?? {}, input.body, "response");
      return operation.operationId;
    },
    async validateFetchResponse(input) {
      const response = input.response.clone();
      const text = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const normalized = contentType.split(";", 1)[0].trim().toLowerCase();
      let body = text;
      if (normalized === "application/json" || normalized.endsWith("+json")) {
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          throw new Error("The OpenAPI runtime returned malformed JSON.");
        }
      }
      return this.validate({
        method: input.method,
        pathname: input.pathname,
        status: response.status,
        contentType,
        body
      });
    }
  };
}

function collectOperations(document) {
  const operations = [];
  for (const [pathname, pathItem] of Object.entries(document?.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method) || !operation?.operationId) continue;
      const parameterCount = (pathname.match(/\{[^}]+\}/gu) ?? []).length;
      operations.push({
        operationId: operation.operationId,
        operation,
        method: method.toUpperCase(),
        pattern: compilePathPattern(pathname),
        parameterCount,
        literalLength: pathname.replace(/\{[^}]+\}/gu, "").length
      });
    }
  }
  return operations.sort((left, right) =>
    left.parameterCount - right.parameterCount
      || right.literalLength - left.literalLength
      || left.operationId.localeCompare(right.operationId)
  );
}

function validateSchema(document, schemaInput, value, location) {
  const schema = resolveSchema(document, schemaInput);
  if (schema.allOf) {
    for (const item of schema.allOf) validateSchema(document, item, value, location);
  }
  if (schema.anyOf || schema.oneOf) {
    const alternatives = schema.anyOf ?? schema.oneOf;
    const accepted = alternatives.some((item) => {
      try {
        validateSchema(document, item, value, location);
        return true;
      } catch {
        return false;
      }
    });
    if (!accepted) throw new Error(`${location} does not match an allowed schema.`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    throw new Error(`${location} does not match its required constant.`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${location} is outside its documented enum.`);
  }
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    throw new Error(`${location} has an undocumented type.`);
  }
  if (value === null || value === undefined) return;
  if ((types.includes("object") || schema.properties) && isObject(value)) {
    for (const field of schema.required ?? []) {
      if (!(field in value)) throw new Error(`${location}.${field} is required.`);
    }
    for (const [field, child] of Object.entries(schema.properties ?? {})) {
      if (field in value) validateSchema(document, child, value[field], `${location}.${field}`);
    }
    if (schema.additionalProperties === false) {
      const documented = new Set(Object.keys(schema.properties ?? {}));
      const unknown = Object.keys(value).find((field) => !documented.has(field));
      if (unknown) throw new Error(`${location}.${unknown} is undocumented.`);
    } else if (isObject(schema.additionalProperties)) {
      const documented = new Set(Object.keys(schema.properties ?? {}));
      for (const [field, childValue] of Object.entries(value)) {
        if (!documented.has(field)) {
          validateSchema(
            document,
            schema.additionalProperties,
            childValue,
            `${location}.${field}`
          );
        }
      }
    }
  }
  if ((types.includes("array") || schema.items) && Array.isArray(value)) {
    if (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems) {
      throw new Error(`${location} has fewer items than documented.`);
    }
    for (const [index, item] of value.entries()) {
      validateSchema(document, schema.items ?? {}, item, `${location}[${index}]`);
    }
  }
}

function resolveSchema(document, schema) {
  if (!schema?.$ref) return schema ?? {};
  if (!schema.$ref.startsWith("#/")) {
    throw new Error("Only local OpenAPI schema references are supported.");
  }
  return schema.$ref.slice(2).split("/").reduce((current, segment) =>
    current?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")], document
  ) ?? {};
}

function matchesType(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compilePathPattern(pathname) {
  const segments = pathname.split("/").map((segment) =>
    /^\{[^}]+\}$/u.test(segment) ? "[^/]+" : escapeRegularExpression(segment)
  );
  return new RegExp(`^${segments.join("/")}$`, "u");
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
