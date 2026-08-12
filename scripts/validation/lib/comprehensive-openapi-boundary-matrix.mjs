export function resolveOpenApiSchema(document, schema, seen = new Set()) {
  if (!schema || typeof schema !== "object") return {};
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/")) {
      throw new Error(`Only local OpenAPI schema references are supported: ${schema.$ref}`);
    }
    if (seen.has(schema.$ref)) return {};
    const target = schema.$ref.slice(2).split("/").reduce(
      (value, segment) => value?.[decodePointerSegment(segment)],
      document
    );
    if (!target) throw new Error(`OpenAPI schema reference is unresolved: ${schema.$ref}`);
    return resolveOpenApiSchema(document, target, new Set([...seen, schema.$ref]));
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.reduce(
      (merged, item) => mergeSchemas(merged, resolveOpenApiSchema(document, item, seen)),
      omitComposition(schema)
    );
  }
  return { ...schema };
}

export function enumerateOpenApiBoundaryCases(input) {
  const schema = resolveOpenApiSchema(input.document, input.schema);
  const rootName = input.name ?? "$";
  const rootExample = structuredClone(input.example);

  if (effectiveType(schema) !== "object") {
    return scalarCases({
      document: input.document,
      schema,
      name: rootName,
      required: input.required === true,
      baseValue: rootExample,
      mutate: (value) => value
    });
  }

  const cases = scalarCases({
    document: input.document,
    schema,
    name: rootName,
    required: input.required === true,
    baseValue: rootExample,
    mutate: (value) => value
  });
  enumerateObject({
    document: input.document,
    schema,
    baseValue: rootExample && typeof rootExample === "object" ? rootExample : {},
    objectPath: [],
    labelPrefix: "",
    cases
  });
  return uniqueCases(cases);
}

export function openApiExampleForSchema(document, schema) {
  return exampleForSchema(document, schema);
}

function enumerateObject(input) {
  const schema = resolveOpenApiSchema(input.document, input.schema);
  const required = new Set(schema.required ?? []);
  if (schema.additionalProperties === false || schema.properties) {
    const label = input.labelPrefix || "$";
    input.cases.push({
      id: `${label}:unknown-field`,
      expectedValidity: "invalid",
      value: mutateAt(input.baseValue, input.objectPath, (current) => ({
        ...(isPlainObject(current) ? current : {}),
        unknownBoundaryField: true
      }))
    });
  }

  for (const [propertyName, unresolved] of Object.entries(schema.properties ?? {})) {
    const propertySchema = resolveOpenApiSchema(input.document, unresolved);
    const propertyPath = [...input.objectPath, propertyName];
    const label = input.labelPrefix ? `${input.labelPrefix}.${propertyName}` : propertyName;
    const currentValue = readAt(input.baseValue, propertyPath);
    input.cases.push(...scalarCases({
      document: input.document,
      schema: propertySchema,
      name: label,
      required: required.has(propertyName),
      baseValue: input.baseValue,
      mutate: (value) => mutateAt(input.baseValue, propertyPath, () => value),
      omit: () => deleteAt(input.baseValue, propertyPath)
    }));

    const type = effectiveType(propertySchema);
    if (type === "object") {
      enumerateObject({
        ...input,
        schema: propertySchema,
        objectPath: propertyPath,
        labelPrefix: label
      });
    } else if (type === "array") {
      enumerateArrayItems({
        ...input,
        schema: propertySchema,
        arrayPath: propertyPath,
        labelPrefix: `${label}[]`,
        currentValue
      });
    }
  }
}

function enumerateArrayItems(input) {
  const itemSchema = resolveOpenApiSchema(input.document, input.schema.items ?? {});
  if (effectiveType(itemSchema) !== "object") return;
  const current = Array.isArray(input.currentValue) && input.currentValue.length > 0
    ? input.currentValue[0]
    : exampleForSchema(input.document, itemSchema);
  const baseValue = mutateAt(input.baseValue, input.arrayPath, (value) => {
    const values = Array.isArray(value) ? structuredClone(value) : [];
    if (values.length === 0) values.push(current);
    return values;
  });
  enumerateObject({
    document: input.document,
    schema: itemSchema,
    baseValue,
    objectPath: [...input.arrayPath, 0],
    labelPrefix: input.labelPrefix,
    cases: input.cases
  });
}

function scalarCases(input) {
  const schema = resolveOpenApiSchema(input.document, input.schema);
  const type = effectiveType(schema);
  const nullable = acceptsNull(schema);
  const cases = [{
    id: `${input.name}:omitted`,
    expectedValidity: input.required ? "invalid" : "valid",
    value: input.omit ? input.omit() : undefined
  }, {
    id: `${input.name}:null`,
    expectedValidity: nullable ? "valid" : "invalid",
    value: input.mutate(null)
  }];

  if (type) {
    cases.push({
      id: `${input.name}:wrong-type`,
      expectedValidity: "invalid",
      value: input.mutate(wrongTypeValue(type))
    });
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    cases.push({
      id: `${input.name}:invalid-enum`,
      expectedValidity: "invalid",
      value: input.mutate("__invalid_boundary_enum__")
    });
  }

  if (type === "string") addStringCases(cases, input, schema);
  if (type === "integer" || type === "number") addNumberCases(cases, input, schema);
  if (type === "boolean") {
    cases.push(validCase(input, "false", false));
    cases.push(validCase(input, "true", true));
  }
  if (type === "array") addArrayCases(cases, input, schema);
  if (type === "object" && schema.additionalProperties === false) {
    cases.push({
      id: `${input.name}:unknown-field`,
      expectedValidity: "invalid",
      value: input.mutate({ unknownBoundaryField: true })
    });
  }
  return uniqueCases(cases);
}

function addStringCases(cases, input, schema) {
  if (Number.isInteger(schema.minLength)) {
    const minimum = constrainedStringAtLength(schema, schema.minLength);
    if (minimum !== null) cases.push(validCase(input, "minimum", minimum));
    if (schema.minLength > 0) {
      cases.push(invalidCase(input, "below-minimum", "x".repeat(schema.minLength - 1)));
    }
  }
  if (Number.isInteger(schema.maxLength)) {
    const maximum = constrainedStringAtLength(schema, schema.maxLength);
    if (maximum !== null) cases.push(validCase(input, "maximum", maximum));
    cases.push(invalidCase(input, "above-maximum", "x".repeat(schema.maxLength + 1)));
  }
  if (typeof schema.pattern === "string") {
    const value = findPatternMismatch(schema.pattern);
    if (value !== null) cases.push(invalidCase(input, "invalid-pattern", value));
  }
  if (typeof schema.format === "string") {
    cases.push(invalidCase(input, "invalid-format", invalidFormatValue(schema.format)));
  }
}

function constrainedStringAtLength(schema, length) {
  const candidates = [schema.example, ...(schema.examples ?? []), ...(schema.enum ?? [])]
    .filter((value) => typeof value === "string" && value.length === length);
  if (candidates.length > 0) return candidates[0];
  if (typeof schema.pattern === "string" && schema.pattern.includes("\\.md$")) {
    return boundedSourcePath(length, ".md", 237);
  }
  if (
    typeof schema.pattern === "string"
    && schema.pattern.includes("(?:[^/]{1,240}/)*[^/]{1,240}$")
  ) {
    return boundedSourcePath(length, "", 240);
  }
  const value = "x".repeat(length);
  if (typeof schema.pattern !== "string") return value;
  try {
    return new RegExp(schema.pattern, "u").test(value) ? value : null;
  } catch {
    return null;
  }
}

function boundedSourcePath(length, suffix, lastSegmentContentMaximum) {
  for (let segmentCount = 1; segmentCount <= length; segmentCount += 1) {
    const separatorCount = segmentCount - 1;
    const contentLength = length - suffix.length - separatorCount;
    const maximumContent = (segmentCount - 1) * 240 + lastSegmentContentMaximum;
    if (contentLength < segmentCount || contentLength > maximumContent) continue;
    let remaining = contentLength;
    const segments = [];
    for (let index = 0; index < segmentCount; index += 1) {
      const maximum = index === segmentCount - 1 ? lastSegmentContentMaximum : 240;
      const minimumForRest = segmentCount - index - 1;
      const size = Math.min(maximum, remaining - minimumForRest);
      segments.push("x".repeat(size));
      remaining -= size;
    }
    segments[segments.length - 1] += suffix;
    return segments.join("/");
  }
  return null;
}

function addNumberCases(cases, input, schema) {
  if (typeof schema.minimum === "number") {
    cases.push(validCase(input, "minimum", schema.minimum));
  }
  if (typeof schema.maximum === "number") {
    cases.push(validCase(input, "maximum", schema.maximum));
  }
  if (typeof schema.minimum === "number") {
    cases.push(invalidCase(input, "below-minimum", schema.minimum - 1));
  }
  if (typeof schema.maximum === "number") {
    cases.push(invalidCase(input, "above-maximum", schema.maximum + 1));
  }
}

function addArrayCases(cases, input, schema) {
  const item = exampleForSchema(input.document, schema.items ?? {});
  if (Number.isInteger(schema.minItems)) {
    cases.push(validCase(input, "minimum", Array.from({ length: schema.minItems }, () => structuredClone(item))));
    if (schema.minItems > 0) {
      cases.push(invalidCase(input, "below-minimum", Array.from({ length: schema.minItems - 1 }, () => structuredClone(item))));
    }
  }
  if (Number.isInteger(schema.maxItems)) {
    cases.push(validCase(input, "maximum", Array.from({ length: schema.maxItems }, () => structuredClone(item))));
    cases.push(invalidCase(input, "above-maximum", Array.from({ length: schema.maxItems + 1 }, () => structuredClone(item))));
  }
}

function validCase(input, suffix, value) {
  return { id: `${input.name}:${suffix}`, expectedValidity: "valid", value: input.mutate(value) };
}

function invalidCase(input, suffix, value) {
  return { id: `${input.name}:${suffix}`, expectedValidity: "invalid", value: input.mutate(value) };
}

function effectiveType(schema) {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const direct = types.find((value) => value !== "null");
  if (direct) return direct;
  for (const keyword of ["oneOf", "anyOf"]) {
    for (const item of schema[keyword] ?? []) {
      const resolved = effectiveType(item);
      if (resolved) return resolved;
    }
  }
  if (schema.properties) return "object";
  return null;
}

function acceptsNull(schema) {
  if (schema.nullable === true) return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  return ["oneOf", "anyOf"].some((keyword) =>
    (schema[keyword] ?? []).some((item) => item.type === "null" || item.const === null));
}

function exampleForSchema(document, unresolved) {
  const schema = resolveOpenApiSchema(document, unresolved);
  if (schema.example !== undefined) return structuredClone(schema.example);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return structuredClone(schema.enum[0]);
  switch (effectiveType(schema)) {
    case "string":
      return "x".repeat(Math.max(1, schema.minLength ?? 1));
    case "integer":
    case "number":
      return schema.minimum ?? 1;
    case "boolean":
      return true;
    case "array":
      return Array.from(
        { length: Math.max(1, schema.minItems ?? 1) },
        () => exampleForSchema(document, schema.items ?? {})
      );
    case "object":
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, value]) =>
        [name, exampleForSchema(document, value)]));
    default:
      return "value";
  }
}

function wrongTypeValue(type) {
  switch (type) {
    case "string": return 1;
    case "integer":
    case "number": return "not-a-number";
    case "boolean": return "not-a-boolean";
    case "array": return {};
    case "object": return [];
    default: return null;
  }
}

function findPatternMismatch(pattern) {
  let matcher;
  try {
    matcher = new RegExp(pattern, "u");
  } catch {
    return null;
  }
  return ["", "!", "../invalid", "__invalid_pattern__"].find((value) => !matcher.test(value)) ?? null;
}

function invalidFormatValue(format) {
  if (format === "date-time") return "not-a-date-time";
  if (format === "date") return "not-a-date";
  if (format === "uri" || format === "url") return "not-a-url";
  if (format === "uuid") return "not-a-uuid";
  return `not-a-${format}`;
}

function mutateAt(value, path, mutation) {
  if (path.length === 0) return mutation(structuredClone(value));
  const clone = structuredClone(value);
  let current = clone;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const nextSegment = path[index + 1];
    if (current[segment] === undefined || current[segment] === null) {
      current[segment] = typeof nextSegment === "number" ? [] : {};
    }
    current = current[segment];
  }
  const finalSegment = path.at(-1);
  current[finalSegment] = mutation(current[finalSegment]);
  return clone;
}

function deleteAt(value, path) {
  const clone = structuredClone(value);
  let current = clone;
  for (const segment of path.slice(0, -1)) {
    if (current?.[segment] === undefined) return clone;
    current = current[segment];
  }
  if (current && typeof current === "object") delete current[path.at(-1)];
  return clone;
}

function readAt(value, path) {
  return path.reduce((current, segment) => current?.[segment], value);
}

function uniqueCases(cases) {
  const seen = new Set();
  return cases.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function mergeSchemas(left, right) {
  return {
    ...left,
    ...right,
    properties: { ...(left.properties ?? {}), ...(right.properties ?? {}) },
    required: [...new Set([...(left.required ?? []), ...(right.required ?? [])])]
  };
}

function omitComposition(schema) {
  const { allOf: _allOf, ...rest } = schema;
  return rest;
}

function decodePointerSegment(value) {
  return value.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
