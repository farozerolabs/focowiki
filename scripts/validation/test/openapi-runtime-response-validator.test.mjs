import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  createOpenApiRuntimeResponseValidator
} from "../lib/openapi-runtime-response-validator.mjs";

const document = JSON.parse(
  fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8")
);

test("validates a real success example against its exported response schema", () => {
  const validator = createOpenApiRuntimeResponseValidator(document);
  const operation = document.paths["/openapi/v2/health"].get;
  const example = operation.responses["200"].content["application/json"].example;

  assert.equal(validator.validate({
    method: "GET",
    pathname: "/openapi/v2/health",
    status: 200,
    contentType: "application/json",
    body: example
  }), "getDeveloperOpenApiHealth");
});

test("rejects missing required fields and undocumented statuses", () => {
  const validator = createOpenApiRuntimeResponseValidator(document);
  assert.throws(() => validator.validate({
    method: "GET",
    pathname: "/openapi/v2/health",
    status: 200,
    contentType: "application/json",
    body: {}
  }), /required/u);
  assert.throws(() => validator.validate({
    method: "GET",
    pathname: "/openapi/v2/health",
    status: 418,
    contentType: "application/json",
    body: {}
  }), /undocumented response status/u);
});

test("matches parameterized operations without accepting unknown routes", () => {
  const validator = createOpenApiRuntimeResponseValidator(document);
  const operation = document.paths[
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}"
  ].get;
  const example = operation.responses["200"].content["application/json"].example;

  assert.equal(validator.validate({
    method: "GET",
    pathname: "/openapi/v2/knowledge-bases/kb-example?limit=1",
    status: 200,
    contentType: "application/json",
    body: example
  }), "getKnowledgeBase");
  assert.throws(() => validator.validate({
    method: "GET",
    pathname: "/openapi/v2/unknown",
    status: 404,
    contentType: "application/json",
    body: {}
  }), /released OpenAPI operation/u);
});
