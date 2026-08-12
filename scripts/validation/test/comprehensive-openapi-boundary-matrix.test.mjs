import assert from "node:assert/strict";
import test from "node:test";
import {
  enumerateOpenApiBoundaryCases,
  resolveOpenApiSchema
} from "../lib/comprehensive-openapi-boundary-matrix.mjs";

const document = {
  components: {
    schemas: {
      Input: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 3 },
          mode: { type: "string", enum: ["file", "hybrid"] },
          limit: { type: "integer", minimum: 1, maximum: 5 },
          enabled: { type: "boolean" },
          note: { type: ["string", "null"] }
        },
        required: ["name", "mode", "limit", "enabled"]
      }
    }
  }
};

test("resolves local component references without mutating the document", () => {
  const resolved = resolveOpenApiSchema(document, { $ref: "#/components/schemas/Input" });

  assert.equal(resolved.type, "object");
  assert.equal(resolved.properties.name.maxLength, 3);
  assert.deepEqual(document.components.schemas.Input.required, ["name", "mode", "limit", "enabled"]);
});

test("enumerates every applicable object-field boundary without sampling", () => {
  const cases = enumerateOpenApiBoundaryCases({
    document,
    schema: { $ref: "#/components/schemas/Input" },
    example: {
      name: "abc",
      mode: "file",
      limit: 3,
      enabled: true,
      note: "ok"
    },
    location: "requestBody"
  });
  const ids = new Set(cases.map((item) => item.id));

  for (const expected of [
    "name:omitted",
    "name:null",
    "name:wrong-type",
    "name:minimum",
    "name:maximum",
    "name:below-minimum",
    "name:above-maximum",
    "mode:invalid-enum",
    "limit:minimum",
    "limit:maximum",
    "limit:below-minimum",
    "limit:above-maximum",
    "enabled:wrong-type",
    "note:null",
    "$:unknown-field"
  ]) {
    assert.ok(ids.has(expected), `missing ${expected}`);
  }

  assert.equal(cases.length, ids.size);
  assert.equal(cases.find((item) => item.id === "note:null")?.expectedValidity, "valid");
  assert.equal(cases.find((item) => item.id === "name:null")?.expectedValidity, "invalid");
  assert.equal(cases.find((item) => item.id === "name:minimum")?.value.name, "x");
  assert.equal(cases.find((item) => item.id === "name:above-maximum")?.value.name, "xxxx");
});

test("enumerates parameter boundaries from the parameter schema", () => {
  const cases = enumerateOpenApiBoundaryCases({
    document,
    schema: { type: "integer", minimum: 1, maximum: 100 },
    example: 20,
    location: "query",
    name: "limit",
    required: false
  });

  assert.deepEqual(
    cases.map((item) => [item.id, item.expectedValidity]),
    [
      ["limit:omitted", "valid"],
      ["limit:null", "invalid"],
      ["limit:wrong-type", "invalid"],
      ["limit:minimum", "valid"],
      ["limit:maximum", "valid"],
      ["limit:below-minimum", "invalid"],
      ["limit:above-maximum", "invalid"]
    ]
  );
});

test("keeps source-path min and max cases inside the documented segment grammar", () => {
  const cases = enumerateOpenApiBoundaryCases({
    document,
    schema: {
      type: "string",
      minLength: 4,
      maxLength: 2_048,
      pattern: "^(?:[^/]{1,240}/)*[^/]{1,237}\\.md$"
    },
    example: "guide.md",
    location: "requestBody",
    name: "relativePath",
    required: true
  });
  const minimum = cases.find((item) => item.id === "relativePath:minimum")?.value;
  const maximum = cases.find((item) => item.id === "relativePath:maximum")?.value;

  assert.equal(minimum, "x.md");
  assert.equal(maximum.length, 2_048);
  assert.match(maximum, /\.md$/u);
  assert.ok(maximum.split("/").every((segment) => segment.length <= 240));
});
