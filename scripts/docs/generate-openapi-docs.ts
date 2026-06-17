import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDeveloperOpenApiDocument } from "../../apps/api/src/developer-openapi/openapi-document.js";

type OpenApiDocument = ReturnType<typeof createDeveloperOpenApiDocument> & {
  paths: Record<string, Record<string, OperationObject>>;
  components: { schemas: Record<string, SchemaObject> };
  "x-field-continuity": Record<string, string[]>;
};
type SchemaObject = Record<string, unknown>;
type OperationObject = Record<string, unknown>;

type LocaleCopy = {
  label: string;
  operationIndexTitle: string;
  operationIndexIntro: string;
  operationColumn: string;
  methodColumn: string;
  pathColumn: string;
  groupColumn: string;
  interfaceDescriptionHeading: string;
  endpointHeading: string;
  fieldColumn: string;
  valueColumn: string;
  operationIdLabel: string;
  authenticationLabel: string;
  authenticationValue: string;
  parametersHeading: string;
  noParameters: string;
  nameColumn: string;
  locationColumn: string;
  requiredColumn: string;
  typeColumn: string;
  descriptionColumn: string;
  requestBodyHeading: string;
  noRequestBody: string;
  requestExampleHeading: string;
  successExampleHeading: string;
  errorExampleHeading: string;
  successfulResponsesHeading: string;
  noSuccessResponse: string;
  errorCodesHeading: string;
  httpStatusColumn: string;
  stableErrorCodeColumn: string;
  explanationColumn: string;
  noErrorResponse: string;
  workflowContinuityHeading: string;
  acceptedValuesHeading: string;
  returnedValuesHeading: string;
  noContinuity: string;
  yes: string;
  no: string;
  groupIntroTemplate: string;
  acceptedLaterTemplate: string;
  webhookDeliveryTitle: string;
  returnedContinuityNotes: Record<string, Record<string, string>>;
  fieldSources: Record<string, string>;
  operationSummaries: Record<string, string>;
  operationDescriptions: Record<string, string>;
  tagLabels: Record<string, string>;
  descriptions: Record<string, string>;
};

type LocaleConfig = {
  key: "root" | "zh-CN";
  copy: LocaleCopy;
  operationsDir: string;
  sidebarPath: string;
  linkPrefix: string;
};

type OperationEntry = {
  method: string;
  path: string;
  tag: string;
  operationId: string;
  summary: string;
  operation: OperationObject;
  slug: string;
};

const repoRoot = process.cwd();
const docsRoot = path.join(repoRoot, "docs");
const publicOpenApiDir = path.join(docsRoot, "public", "openapi");
const generatedDir = path.join(docsRoot, ".vitepress", "generated");
const localeCopyPath = path.join(docsRoot, ".vitepress", "openapi-locales.json");
const contractPath = path.join(publicOpenApiDir, "focowiki-openapi.json");
const methods = new Set(["get", "post", "put", "patch", "delete"]);

async function main() {
  const document = createDeveloperOpenApiDocument() as OpenApiDocument;
  const operations = collectOperations(document);
  const locales = await readLocales();

  await mkdir(publicOpenApiDir, { recursive: true });
  await mkdir(generatedDir, { recursive: true });
  await writeFile(contractPath, `${JSON.stringify(document, null, 2)}\n`);

  for (const locale of locales) {
    await rm(locale.operationsDir, { recursive: true, force: true });
    await mkdir(locale.operationsDir, { recursive: true });
    await writeFile(path.join(locale.operationsDir, "index.md"), renderOperationsIndex(locale.copy, operations));
    for (const entry of operations) {
      await writeFile(path.join(locale.operationsDir, `${entry.slug}.md`), renderOperationPage(document, locale.copy, entry));
    }
    await writeFile(locale.sidebarPath, `${JSON.stringify(createSidebar(locale, operations), null, 2)}\n`);
  }

  console.log(`Generated ${operations.length} OpenAPI operation pages for ${locales.length} locales.`);
}

async function readLocales(): Promise<LocaleConfig[]> {
  const copies = JSON.parse(await readFile(localeCopyPath, "utf8")) as Record<"en-US" | "zh-CN", LocaleCopy>;
  return [
    {
      key: "root",
      copy: copies["en-US"],
      operationsDir: path.join(docsRoot, "openapi", "operations"),
      sidebarPath: path.join(generatedDir, "openapi-sidebar.json"),
      linkPrefix: "/openapi/operations"
    },
    {
      key: "zh-CN",
      copy: copies["zh-CN"],
      operationsDir: path.join(docsRoot, "zh-CN", "openapi", "operations"),
      sidebarPath: path.join(generatedDir, "openapi-sidebar.zh-CN.json"),
      linkPrefix: "/zh-CN/openapi/operations"
    }
  ];
}

function collectOperations(document: OpenApiDocument): OperationEntry[] {
  return Object.entries(document.paths)
    .flatMap(([apiPath, pathItem]) =>
      Object.entries(pathItem)
        .filter(([method]) => methods.has(method))
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          path: apiPath,
          tag: readFirstString(operation.tags) ?? "Other",
          operationId: String(operation.operationId),
          summary: String(operation.summary),
          operation,
          slug: slugifyOperationId(String(operation.operationId))
        }))
    )
    .sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function renderOperationsIndex(copy: LocaleCopy, operations: OperationEntry[]): string {
  return [
    "---",
    `title: ${yamlString(copy.operationIndexTitle)}`,
    "---",
    "",
    `# ${copy.operationIndexTitle}`,
    "",
    copy.operationIndexIntro,
    "",
    `| ${copy.operationColumn} | ${copy.methodColumn} | ${copy.pathColumn} | ${copy.groupColumn} |`,
    "| --- | --- | --- | --- |",
    ...operations.map((entry) => {
      const summary = operationSummary(copy, entry);
      return `| [${escapeTable(summary)}](./${entry.slug}.md) | \`${entry.method}\` | \`${entry.path}\` | ${escapeTable(
        tagLabel(copy, entry.tag)
      )} |`;
    }),
    ""
  ].join("\n");
}

function renderOperationPage(document: OpenApiDocument, copy: LocaleCopy, entry: OperationEntry): string {
  const successResponses = Object.entries(readRecord(entry.operation.responses)).filter(([status]) => status.startsWith("2"));
  const errorResponses = Object.entries(readRecord(entry.operation.responses)).filter(([status]) => !status.startsWith("2"));
  const parameters = readArray(entry.operation.parameters) as SchemaObject[];
  const requestBody = readRecord(entry.operation.requestBody);
  const continuity = document["x-field-continuity"];
  const returnedFields = collectReturnedContinuityFields(document, successResponses, Object.keys(continuity));
  const requestedFields = parameters
    .map((parameter) => String(parameter.name ?? ""))
    .filter((name) => name in copy.fieldSources);
  const summary = operationSummary(copy, entry);
  const group = tagLabel(copy, entry.tag);

  return [
    "---",
    `title: ${yamlString(summary)}`,
    `operationId: ${yamlString(entry.operationId)}`,
    `method: ${yamlString(entry.method)}`,
    `path: ${yamlString(entry.path)}`,
    "---",
    "",
    `# ${summary}`,
    "",
    `## ${copy.interfaceDescriptionHeading}`,
    "",
    operationDescription(copy, entry),
    "",
    copy.groupIntroTemplate.replace("{group}", group),
    "",
    `## ${copy.endpointHeading}`,
    "",
    `| ${copy.fieldColumn} | ${copy.valueColumn} |`,
    "| --- | --- |",
    `| ${copy.methodColumn} | \`${entry.method}\` |`,
    `| ${copy.pathColumn} | \`${entry.path}\` |`,
    `| ${copy.operationIdLabel} | \`${entry.operationId}\` |`,
    `| ${copy.authenticationLabel} | ${copy.authenticationValue} |`,
    "",
    `## ${copy.parametersHeading}`,
    "",
    renderParameters(copy, parameters),
    "",
    `## ${copy.requestBodyHeading}`,
    "",
    renderRequestBody(document, copy, requestBody),
    "",
    `## ${copy.requestExampleHeading}`,
    "",
    renderRequestExample(entry),
    "",
    `## ${copy.successfulResponsesHeading}`,
    "",
    renderSuccessResponses(document, copy, successResponses),
    "",
    `## ${copy.successExampleHeading}`,
    "",
    renderSuccessExample(successResponses),
    "",
    `## ${copy.errorCodesHeading}`,
    "",
    renderErrorResponses(copy, errorResponses),
    "",
    `## ${copy.errorExampleHeading}`,
    "",
    renderErrorExample(errorResponses),
    "",
    `## ${copy.workflowContinuityHeading}`,
    "",
    renderContinuity(copy, entry.operationId, requestedFields, returnedFields, continuity),
    ""
  ].join("\n");
}

function renderRequestExample(entry: OperationEntry): string {
  const requestExample = readRecord(entry.operation["x-request-example"]);
  const pathParameters = readRecord(requestExample.path);
  const query = readRecord(requestExample.query);
  const body = readRecord(requestExample.body);
  const url = `https://openapi.example.com${buildExamplePath(entry.path, pathParameters, query)}`;
  const requestBody = readRecord(entry.operation.requestBody);
  const content = readRecord(requestBody.content);
  const contentTypes = Object.keys(content);
  const isMultipart = contentTypes.includes("multipart/form-data");
  const isJsonBody = contentTypes.includes("application/json");
  const lines = [`curl -X ${entry.method} ${JSON.stringify(url)}`, '  -H "Authorization: Bearer <openapi-key>"'];

  if (isJsonBody && Object.keys(body).length > 0) {
    lines.push('  -H "Content-Type: application/json"');
    lines.push(`  --data '${JSON.stringify(body, null, 2)}'`);
  } else if (isMultipart) {
    const files = Array.isArray(body.files) ? body.files.map(String) : ["example.md"];
    for (const file of files) {
      lines.push(`  -F "files=@${file};type=text/markdown"`);
    }
  }

  return ["```bash", lines.join(" \\\n"), "```"].join("\n");
}

function renderSuccessExample(responses: [string, unknown][]): string {
  for (const [, response] of responses) {
    const example = readRecord(readRecord(readRecord(response).content)["application/json"]).example;
    if (example !== undefined) {
      return renderJsonBlock(example);
    }
  }
  return "No success response example is documented.";
}

function renderErrorExample(responses: [string, unknown][]): string {
  const preferred = responses.find(([status]) => status === "401") ?? responses[0];
  const example = readRecord(readRecord(readRecord(preferred?.[1]).content)["application/json"]).example;
  if (example !== undefined) {
    return renderJsonBlock(example);
  }
  return "No error response example is documented.";
}

function renderParameters(copy: LocaleCopy, parameters: SchemaObject[]): string {
  if (parameters.length === 0) {
    return copy.noParameters;
  }
  return [
    `| ${copy.nameColumn} | ${copy.locationColumn} | ${copy.requiredColumn} | ${copy.typeColumn} | ${copy.descriptionColumn} |`,
    "| --- | --- | --- | --- | --- |",
    ...parameters.map((parameter) => {
      const schema = readRecord(parameter.schema);
      return `| \`${String(parameter.name)}\` | ${String(parameter.in)} | ${yesNo(copy, Boolean(parameter.required))} | ${escapeTable(
        schemaType(schema)
      )} | ${escapeTable(translateDescription(copy, String(parameter.description ?? "")))} |`;
    })
  ].join("\n");
}

function renderRequestBody(document: OpenApiDocument, copy: LocaleCopy, requestBody: SchemaObject): string {
  if (Object.keys(requestBody).length === 0) {
    return copy.noRequestBody;
  }
  const content = readRecord(requestBody.content);
  return Object.entries(content)
    .map(([contentType, contentValue]) => {
      const schema = resolveSchema(document, readRecord(readRecord(contentValue).schema));
      return [`### ${contentType}`, "", renderSchemaFields(document, copy, schema)].join("\n");
    })
    .join("\n\n");
}

function renderSuccessResponses(document: OpenApiDocument, copy: LocaleCopy, responses: [string, unknown][]): string {
  if (responses.length === 0) {
    return copy.noSuccessResponse;
  }
  return responses
    .map(([status, response]) => {
      const responseObject = readRecord(response);
      const schema = responseSchema(responseObject);
      return [
        `### ${status}`,
        "",
        translateDescription(copy, String(responseObject.description ?? "Successful response.")),
        "",
        renderSchemaFields(document, copy, resolveSchema(document, schema))
      ].join("\n");
    })
    .join("\n\n");
}

function renderErrorResponses(copy: LocaleCopy, responses: [string, unknown][]): string {
  if (responses.length === 0) {
    return copy.noErrorResponse;
  }
  return [
    `| ${copy.httpStatusColumn} | ${copy.stableErrorCodeColumn} | ${copy.explanationColumn} |`,
    "| --- | --- | --- |",
    ...responses.map(([status, response]) => {
      const responseObject = readRecord(response);
      return `| ${status} | \`${errorCodeForStatus(status)}\` | ${escapeTable(
        translateDescription(copy, String(responseObject.description ?? ""))
      )} |`;
    })
  ].join("\n");
}

function renderContinuity(
  copy: LocaleCopy,
  operationId: string,
  requestedFields: string[],
  returnedFields: string[],
  continuity: Record<string, string[]>
): string {
  const lines: string[] = [];
  if (requestedFields.length > 0) {
    lines.push(`### ${copy.acceptedValuesHeading}`, "");
    for (const field of requestedFields) {
      lines.push(`- \`${field}\`: ${copy.fieldSources[field]}`);
    }
    lines.push("");
  }
  if (returnedFields.length > 0) {
    lines.push(`### ${copy.returnedValuesHeading}`, "");
    for (const field of returnedFields) {
      const operationNote = copy.returnedContinuityNotes[operationId]?.[field];
      if (operationNote) {
        lines.push(`- \`${field}\`: ${operationNote}`);
        continue;
      }
      const targets = continuity[field] ?? [];
      lines.push(
        `- \`${field}\`: ${copy.acceptedLaterTemplate.replace(
          "{targets}",
          targets.map((target) => `\`${target}\``).join(", ")
        )}`
      );
    }
  }
  if (lines.length === 0) {
    return copy.noContinuity;
  }
  return lines.join("\n");
}

function renderSchemaFields(document: OpenApiDocument, copy: LocaleCopy, schema: SchemaObject): string {
  const properties = schemaProperties(document, schema);
  if (properties.length === 0) {
    return `Schema type: \`${schemaType(schema)}\`.`;
  }
  return [
    `| ${copy.fieldColumn} | ${copy.requiredColumn} | ${copy.typeColumn} | ${copy.descriptionColumn} |`,
    "| --- | --- | --- | --- |",
    ...properties.map(
      ({ name, required, schema: propertySchema }) =>
        `| \`${name}\` | ${yesNo(copy, required)} | ${escapeTable(schemaType(propertySchema))} | ${escapeTable(
          translateDescription(copy, String(propertySchema.description ?? ""))
        )} |`
    )
  ].join("\n");
}

function schemaProperties(document: OpenApiDocument, schema: SchemaObject) {
  const resolved = resolveSchema(document, schema);
  const ownProperties = readRecord(resolved.properties);
  const merged = new Map<string, { name: string; required: boolean; schema: SchemaObject }>();
  for (const item of readArray(resolved.allOf)) {
    for (const property of schemaProperties(document, readRecord(item))) {
      merged.set(property.name, property);
    }
  }
  const required = new Set(readArray(resolved.required).map(String));
  for (const [name, propertySchema] of Object.entries(ownProperties)) {
    merged.set(name, {
      name,
      required: required.has(name),
      schema: resolveSchema(document, readRecord(propertySchema))
    });
  }
  return [...merged.values()];
}

function collectReturnedContinuityFields(
  document: OpenApiDocument,
  responses: [string, unknown][],
  fieldNames: string[]
): string[] {
  const found = new Set<string>();
  for (const [, response] of responses) {
    collectSchemaFieldNames(document, responseSchema(readRecord(response)), new Set(fieldNames), found, 0);
  }
  return [...found].sort();
}

function collectSchemaFieldNames(
  document: OpenApiDocument,
  schema: SchemaObject,
  targets: Set<string>,
  found: Set<string>,
  depth: number
) {
  if (depth > 4) {
    return;
  }
  const resolved = resolveSchema(document, schema);
  for (const [name, propertySchema] of Object.entries(readRecord(resolved.properties))) {
    if (targets.has(name)) {
      found.add(name);
    }
    collectSchemaFieldNames(document, readRecord(propertySchema), targets, found, depth + 1);
  }
  for (const item of [...readArray(resolved.oneOf), ...readArray(resolved.anyOf), ...readArray(resolved.allOf)]) {
    collectSchemaFieldNames(document, readRecord(item), targets, found, depth + 1);
  }
  const items = readRecord(resolved.items);
  if (Object.keys(items).length > 0) {
    collectSchemaFieldNames(document, items, targets, found, depth + 1);
  }
}

function responseSchema(response: SchemaObject): SchemaObject {
  const content = readRecord(response.content);
  const json = readRecord(content["application/json"]);
  return readRecord(json.schema);
}

function resolveSchema(document: OpenApiDocument, schema: SchemaObject): SchemaObject {
  const ref = schema.$ref;
  if (typeof ref !== "string") {
    return schema;
  }
  const name = ref.replace("#/components/schemas/", "");
  return document.components.schemas[name] ?? schema;
}

function schemaType(schema: SchemaObject): string {
  if (typeof schema.$ref === "string") {
    return schema.$ref.replace("#/components/schemas/", "");
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map(String).join(" | ");
  }
  if ("const" in schema) {
    return JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.oneOf)) {
    return `oneOf(${schema.oneOf.map((item) => schemaType(readRecord(item))).join(", ")})`;
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((item) => schemaType(readRecord(item))).join(" | ");
  }
  if (Array.isArray(schema.allOf)) {
    return `allOf(${schema.allOf.map((item) => schemaType(readRecord(item))).join(", ")})`;
  }
  if (schema.type === "array") {
    return `array<${schemaType(readRecord(schema.items))}>`;
  }
  if (typeof schema.type === "string") {
    return schema.type;
  }
  return "object";
}

function createSidebar(locale: LocaleConfig, operations: OperationEntry[]) {
  const groups = new Map<string, OperationEntry[]>();
  for (const operation of operations) {
    groups.set(operation.tag, [...(groups.get(operation.tag) ?? []), operation]);
  }
  const openApiRoot = locale.linkPrefix.replace(/\/operations$/, "");
  return [
    { text: locale.copy.operationIndexTitle, link: `${locale.linkPrefix}/` },
    ...[...groups.entries()].map(([tag, entries]) => {
      const operationItems = entries.map((entry) => ({
        text: operationSummary(locale.copy, entry),
        link: `${locale.linkPrefix}/${entry.slug}`
      }));
      const items =
        tag === "Webhooks"
          ? [{ text: locale.copy.webhookDeliveryTitle, link: `${openApiRoot}/webhook-delivery` }, ...operationItems]
          : operationItems;

      return {
        text: tagLabel(locale.copy, tag),
        collapsed: true,
        items
      };
    })
  ];
}

function errorCodeForStatus(status: string): string {
  const map: Record<string, string> = {
    "401": "UNAUTHORIZED",
    "403": "FORBIDDEN",
    "404": "NOT_FOUND",
    "409": "CONFLICT",
    "413": "PAYLOAD_TOO_LARGE",
    "422": "VALIDATION_ERROR",
    "429": "RATE_LIMITED",
    "500": "INTERNAL_ERROR"
  };
  return map[status] ?? "ERROR";
}

function operationSummary(copy: LocaleCopy, entry: OperationEntry): string {
  return copy.operationSummaries[entry.operationId] ?? entry.summary;
}

function operationDescription(copy: LocaleCopy, entry: OperationEntry): string {
  return copy.operationDescriptions[entry.operationId] ?? entry.summary;
}

function tagLabel(copy: LocaleCopy, tag: string): string {
  return copy.tagLabels[tag] ?? tag;
}

function translateDescription(copy: LocaleCopy, value: string): string {
  return copy.descriptions[value] ?? value;
}

function slugifyOperationId(operationId: string): string {
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function readRecord(value: unknown): SchemaObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as SchemaObject;
  }
  return {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readFirstString(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
}

function yesNo(copy: LocaleCopy, value: boolean): string {
  return value ? copy.yes : copy.no;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function escapeTable(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function buildExamplePath(apiPath: string, pathParameters: SchemaObject, query: SchemaObject): string {
  let output = apiPath;
  for (const [name, value] of Object.entries(pathParameters)) {
    output = output.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) {
      params.set(name, String(value));
    }
  }
  const queryString = params.toString();
  return queryString ? `${output}?${queryString}` : output;
}

function renderJsonBlock(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

await main();
