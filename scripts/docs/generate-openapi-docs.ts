import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDeveloperOpenApiDocument } from "../../apps/api/src/developer-openapi/openapi-document.js";

type OpenApiDocument = ReturnType<typeof createDeveloperOpenApiDocument> & {
  paths: Record<string, Record<string, OperationObject>>;
  components: { schemas: Record<string, SchemaObject> };
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
  exampleColumn: string;
  descriptionColumn: string;
  requestBodyHeading: string;
  noRequestBody: string;
  requestExampleHeading: string;
  successExampleHeading: string;
  successfulResponsesHeading: string;
  noSuccessResponse: string;
  errorCodesHeading: string;
  httpStatusColumn: string;
  stableErrorCodeColumn: string;
  explanationColumn: string;
  noErrorResponse: string;
  commonErrorsNote: string;
  nextStepsHeading: string;
  yes: string;
  no: string;
  webhookDeliveryTitle: string;
  operationSummaries: Record<string, string>;
  operationDescriptions: Record<string, string>;
  tagLabels: Record<string, string>;
  fieldDescriptions: Record<string, string>;
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
const tagOrder = new Map(
  [
    "Metadata",
    "Knowledge Bases",
    "Upload Sessions",
    "Source Directories",
    "Source Files",
    "Resource Operations",
    "Files",
    "Webhooks"
  ].map((tag, index) => [tag, index])
);
const nextOperationIds: Record<string, string[]> = {
  createKnowledgeBase: ["createUploadSession", "getKnowledgeBase"],
  createUploadSession: ["addUploadManifestEntries", "getUploadSession"],
  addUploadManifestEntries: ["sealUploadManifest", "getUploadSession"],
  sealUploadManifest: ["uploadSessionContentBatch", "getUploadSession"],
  uploadSessionContentBatch: ["finalizeUploadSession", "getUploadSession"],
  reconcileUploadSession: ["getUploadSession", "finalizeUploadSession"],
  finalizeUploadSession: ["getUploadSession", "listKnowledgeBaseSourceFiles"],
  getUploadSession: ["uploadSessionContentBatch", "reconcileUploadSession", "finalizeUploadSession"],
  getKnowledgeBaseSourceFile: ["getSourceFileContent", "listKnowledgeBaseSourceFileEvents"],
  moveSourceFile: ["getResourceOperation"],
  replaceSourceFileContent: ["getResourceOperation"],
  deleteSourceFile: ["getResourceOperation"],
  moveSourceDirectory: ["getResourceOperation"],
  deleteSourceDirectory: ["getResourceOperation"],
  listKnowledgeBaseTree: ["getFileContentByPath", "getFileContentById"],
  searchGeneratedFiles: ["getFileContentByPath", "getFileContentById", "expandGraph"],
  expandGraph: ["getFileContentByPath", "listRelatedFiles"],
  listRelatedFiles: ["getFileContentByPath", "expandGraph"],
  createWebhook: ["listWebhookDeliveries"],
  listWebhookDeliveries: ["redeliverWebhook"]
};

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
      await writeFile(
        path.join(locale.operationsDir, `${entry.slug}.md`),
        renderOperationPage(document, locale.copy, entry, operations)
      );
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
    .sort(
      (a, b) =>
        (tagOrder.get(a.tag) ?? Number.MAX_SAFE_INTEGER) -
          (tagOrder.get(b.tag) ?? Number.MAX_SAFE_INTEGER) ||
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method)
    );
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

function renderOperationPage(
  document: OpenApiDocument,
  copy: LocaleCopy,
  entry: OperationEntry,
  operations: OperationEntry[]
): string {
  const successResponses = Object.entries(readRecord(entry.operation.responses)).filter(([status]) => status.startsWith("2"));
  const errorResponses = Object.entries(readRecord(entry.operation.responses)).filter(([status]) => !status.startsWith("2"));
  const parameters = readArray(entry.operation.parameters) as SchemaObject[];
  const requestBody = readRecord(entry.operation.requestBody);
  const summary = operationSummary(copy, entry);
  const nextSteps = renderNextSteps(copy, entry.operationId, operations);

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
    renderParameters(copy, parameters, entry),
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
    ...(nextSteps ? ["", `## ${copy.nextStepsHeading}`, "", nextSteps] : []),
    ""
  ].join("\n");
}

function renderRequestExample(entry: OperationEntry): string {
  const requestExample = readRecord(entry.operation["x-request-example"]);
  const pathParameters = readRecord(requestExample.path);
  const query = readRecord(requestExample.query);
  const headerExamples = readRecord(requestExample.header);
  const rawBody = requestExample.body;
  const body = readRecord(rawBody);
  const url = `https://openapi.example.com${buildExamplePath(entry.path, pathParameters, query)}`;
  const requestBody = readRecord(entry.operation.requestBody);
  const content = readRecord(requestBody.content);
  const contentTypes = Object.keys(content);
  const isMultipart = contentTypes.includes("multipart/form-data");
  const isJsonBody = contentTypes.includes("application/json");
  const isMarkdownBody = contentTypes.includes("text/markdown");
  const lines = [`curl -X ${entry.method} ${JSON.stringify(url)}`, '  -H "Authorization: Bearer <openapi-key>"'];

  for (const parameterValue of readArray(entry.operation.parameters)) {
    const parameter = readRecord(parameterValue);
    if (parameter.in !== "header" || typeof parameter.name !== "string") {
      continue;
    }
    const schema = readRecord(parameter.schema);
    const value =
      headerExamples[parameter.name] ??
      schema.example ??
      parameterExample(entry, parameter, schema);
    lines.push(`  -H ${JSON.stringify(`${parameter.name}: ${String(value)}`)}`);
  }

  if (isJsonBody && Object.keys(body).length > 0) {
    lines.push('  -H "Content-Type: application/json"');
    lines.push(`  --data '${JSON.stringify(body, null, 2)}'`);
  } else if (isMultipart) {
    const entries = Object.entries(body);
    for (const [entryId, file] of entries) {
      lines.push(`  -F "${entryId}=@${String(file)};type=text/markdown"`);
    }
  } else if (isMarkdownBody && typeof rawBody === "string") {
    lines.push('  -H "Content-Type: text/markdown"');
    lines.push(`  --data-binary ${JSON.stringify(rawBody)}`);
  }

  return ["```bash", lines.join(" \\\n"), "```"].join("\n");
}

function renderSuccessExample(responses: [string, unknown][]): string {
  for (const [, response] of responses) {
    const content = readRecord(readRecord(response).content);
    for (const [contentType, media] of Object.entries(content)) {
      const example = readRecord(media).example;
      if (example !== undefined) {
        return contentType === "application/json"
          ? renderJsonBlock(example)
          : ["```", String(example), "```"].join("\n");
      }
    }
  }
  return "No success response example is documented.";
}

function renderParameters(copy: LocaleCopy, parameters: SchemaObject[], entry: OperationEntry): string {
  if (parameters.length === 0) {
    return copy.noParameters;
  }
  return [
    `| ${copy.nameColumn} | ${copy.locationColumn} | ${copy.requiredColumn} | ${copy.typeColumn} | ${copy.exampleColumn} | ${copy.descriptionColumn} |`,
    "| --- | --- | --- | --- | --- | --- |",
    ...parameters.map((parameter) => {
      const schema = readRecord(parameter.schema);
      const example = parameterExample(entry, parameter, schema);
      return `| \`${String(parameter.name)}\` | ${String(parameter.in)} | ${yesNo(copy, Boolean(parameter.required))} | ${escapeTable(
        schemaType(schema)
      )} | ${escapeTable(example)} | ${escapeTable(fieldDescription(copy, String(parameter.name), parameter.description))} |`;
    })
  ].join("\n");
}

function parameterExample(entry: OperationEntry, parameter: SchemaObject, schema: SchemaObject): string {
  const name = String(parameter.name ?? "");
  const location = String(parameter.in ?? "");
  const requestExample = readRecord(entry.operation["x-request-example"]);
  const explicitExample = readRecord(requestExample[location])[name];
  if (explicitExample !== undefined && explicitExample !== null) {
    return formatInlineExample(explicitExample);
  }
  if (schema.example !== undefined && schema.example !== null) {
    return formatInlineExample(schema.example);
  }
  const namedExample = parameterExampleByName(name);
  if (namedExample) {
    return namedExample;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return formatInlineExample(schema.enum[0]);
  }
  if (schema.format === "date-time") {
    return "2026-06-17T00:00:00.000Z";
  }
  if (schema.type === "integer" || schema.type === "number") {
    return "50";
  }
  if (schema.type === "boolean") {
    return "true";
  }
  return "example";
}

function parameterExampleByName(name: string): string | undefined {
  const examples: Record<string, string> = {
    knowledgeBaseId: "kb_123",
    sourceFileId: "source-file-11111111-1111-4111-8111-111111111111",
    fileId: "bundle-file-11111111-1111-4111-8111-111111111111",
    webhookId: "webhook_123",
    deliveryId: "delivery_123",
    cursor: "cursor_123",
    limit: "50",
    path: "pages/guide.md",
    parentPath: "pages",
    pathQuery: "handbook/guide",
    sourceFileIdPrefix: "source-file-11111111",
    processingState: "completed",
    currentStage: "release_activation",
    generatedOutputStatus: "visible",
    startedFrom: "2026-06-17T00:00:00.000Z",
    startedTo: "2026-06-18T00:00:00.000Z",
    endedFrom: "2026-06-17T00:00:00.000Z",
    endedTo: "2026-06-18T00:00:00.000Z",
    errorState: "with_error",
    errorCodeQuery: "MODEL_SUGGESTION_FAILED",
    actionState: "openable",
    entryType: "file"
  };
  return examples[name];
}

function formatInlineExample(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function renderRequestBody(document: OpenApiDocument, copy: LocaleCopy, requestBody: SchemaObject): string {
  if (Object.keys(requestBody).length === 0) {
    return copy.noRequestBody;
  }
  const content = readRecord(requestBody.content);
  return Object.entries(content)
    .map(([contentType, contentValue]) => {
      const mediaTypeObject = readRecord(contentValue);
      const schema = resolveSchema(document, readRecord(mediaTypeObject.schema));
      const example = readRecord(mediaTypeObject.example);
      return [`### ${contentType}`, "", renderSchemaFields(document, copy, schema, { example })].join("\n");
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
  const operationSpecific = responses.filter(([status]) => !["401", "429", "500"].includes(status));
  if (operationSpecific.length === 0) return copy.commonErrorsNote;
  return [
    copy.commonErrorsNote,
    "",
    `| ${copy.httpStatusColumn} | ${copy.stableErrorCodeColumn} | ${copy.explanationColumn} |`,
    "| --- | --- | --- |",
    ...operationSpecific.map(([status, response]) => {
      const responseObject = readRecord(response);
      return `| ${status} | \`${errorCodeForStatus(status)}\` | ${escapeTable(
        translateDescription(copy, String(responseObject.description ?? ""))
      )} |`;
    })
  ].join("\n");
}

function renderNextSteps(copy: LocaleCopy, operationId: string, operations: OperationEntry[]): string {
  const operationById = new Map(operations.map((operation) => [operation.operationId, operation]));
  return (nextOperationIds[operationId] ?? [])
    .map((nextOperationId) => operationById.get(nextOperationId))
    .filter((operation): operation is OperationEntry => Boolean(operation))
    .map((operation) => `- [${operationSummary(copy, operation)}](./${operation.slug}.md)`)
    .join("\n");
}

function renderSchemaFields(
  document: OpenApiDocument,
  copy: LocaleCopy,
  schema: SchemaObject,
  options: { example?: SchemaObject } = {}
): string {
  const properties = schemaProperties(document, schema);
  if (properties.length === 0) {
    return `Schema type: \`${schemaType(schema)}\`.`;
  }
  if (options.example) {
    return [
      `| ${copy.fieldColumn} | ${copy.requiredColumn} | ${copy.typeColumn} | ${copy.exampleColumn} | ${copy.descriptionColumn} |`,
      "| --- | --- | --- | --- | --- |",
      ...properties.map(({ name, required, schema: propertySchema }) => {
        const example = schemaFieldExample(name, propertySchema, options.example?.[name]);
        return `| \`${name}\` | ${yesNo(copy, required)} | ${escapeTable(schemaType(propertySchema))} | ${escapeTable(
          example
        )} | ${escapeTable(fieldDescription(copy, name, propertySchema.description))} |`;
      })
    ].join("\n");
  }
  return [
    `| ${copy.fieldColumn} | ${copy.requiredColumn} | ${copy.typeColumn} | ${copy.descriptionColumn} |`,
    "| --- | --- | --- | --- |",
    ...properties.map(
      ({ name, required, schema: propertySchema }) =>
        `| \`${name}\` | ${yesNo(copy, required)} | ${escapeTable(schemaType(propertySchema))} | ${escapeTable(
          fieldDescription(copy, name, propertySchema.description)
        )} |`
    )
  ].join("\n");
}

function schemaFieldExample(name: string, schema: SchemaObject, explicitExample: unknown): string {
  if (explicitExample !== undefined && explicitExample !== null) {
    return formatInlineExample(explicitExample);
  }
  const namedExample = requestBodyFieldExampleByName(name);
  if (namedExample) {
    return namedExample;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return formatInlineExample(schema.enum[0]);
  }
  if (schema.format === "date-time") {
    return "2026-06-17T00:00:00.000Z";
  }
  if (schema.type === "array") {
    return "[\"example\"]";
  }
  if (schema.type === "integer" || schema.type === "number") {
    return "1";
  }
  if (schema.type === "boolean") {
    return "true";
  }
  return "example";
}

function requestBodyFieldExampleByName(name: string): string | undefined {
  const examples: Record<string, string> = {
    name: "Product Docs",
    description: "Product documentation",
    files: "[\"guide.md\", \"faq.md\"]",
    sourceFileIds: "[\"source-file-11111111-1111-4111-8111-111111111111\"]",
    url: "https://hooks.example.com/focowiki",
    events: "[\"source_file.completed\", \"source_file.failed\"]"
  };
  return examples[name];
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
    "500": "INTERNAL_ERROR",
    "503": "QUEUE_BACKPRESSURE"
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

function fieldDescription(copy: LocaleCopy, name: string, description: unknown): string {
  const translated = translateDescription(copy, String(description ?? "")).trim();
  return translated || copy.fieldDescriptions[name] || copy.fieldDescriptions.value;
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
