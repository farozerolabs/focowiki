import fs from "node:fs";
import path from "node:path";

import {
  buildOpenApiDocumentationReview
} from "./lib/comprehensive-openapi-doc-review.mjs";

const repositoryRoot = process.cwd();
const reportDirectory = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR
    || "ReferenceDocs/validation/comprehensive-large-scale-release"
);
const reportPath = path.join(reportDirectory, "developer-openapi-document-response-review.json");
const document = JSON.parse(
  fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8")
);

const report = buildOpenApiDocumentationReview({
  document,
  repositoryRoot,
  evidenceDirectory: reportDirectory
});
report.startedAt = new Date().toISOString();
report.runtimeContract = await validateRuntimeContract(document);
report.finishedAt = new Date().toISOString();
report.ok = report.ok && report.runtimeContract.ok;

fs.mkdirSync(reportDirectory, { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

for (const operation of report.operations) {
  process.stdout.write(`${JSON.stringify({
    operationId: operation.operationId,
    method: operation.method,
    parameterCount: operation.parameterCount,
    requestFieldCount: operation.requestFieldCount,
    responseFieldCount: operation.responseFieldCount,
    responseStatuses: operation.responseStatuses,
    responseHeaderCount: operation.responseHeaderCount,
    exampleValidated: operation.exampleValidated,
    lifecycleVerified: operation.lifecycleVerified,
    securityVerified: operation.securityVerified,
    boundaryVerified: operation.boundaryVerified,
    rateLimitVerified: operation.rateLimitVerified,
    hostVerified: operation.hostVerified
  })}\n`);
}
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  operationCount: report.operations.length,
  pageCount: report.pages.length,
  responseItemCount: report.responseItems.length,
  responseFieldCount: report.responseItems.filter((item) => item.kind === "response-field").length,
  responseHeaderCount: report.responseItems.filter((item) => item.kind === "response-header").length,
  responseStatusCount: report.responseItems.filter((item) => item.kind === "response-status").length,
  failureCount: report.failures.length,
  runtimeContract: report.runtimeContract,
  reportPath
})}\n`);

if (!report.ok) throw new Error("Developer OpenAPI documentation and response review failed.");

async function validateRuntimeContract(expectedDocument) {
  const keyFile = process.env.FOCOWIKI_OPENAPI_KEY_FILE?.trim();
  if (!keyFile) {
    return { ok: false, status: null, exactMatch: false, reason: "OpenAPI key file is required." };
  }
  const rawKey = fs.readFileSync(path.resolve(keyFile), "utf8").trim();
  const publicBaseUrl = process.env.FOCOWIKI_PUBLIC_BASE_URL?.trim()
    || `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`;
  const response = await fetch(`${publicBaseUrl}/openapi/v2/openapi.json`, {
    headers: { authorization: `Bearer ${rawKey}` }
  });
  const body = await response.json().catch(() => null);
  const expectedOperations = collectOperationIds(expectedDocument);
  const actualOperations = collectOperationIds(body);
  const exactMatch = JSON.stringify(body) === JSON.stringify(expectedDocument);
  return {
    ok: response.status === 200
      && exactMatch
      && expectedOperations.length === 42
      && actualOperations.length === 42,
    status: response.status,
    exactMatch,
    expectedOperationCount: expectedOperations.length,
    actualOperationCount: actualOperations.length
  };
}

function collectOperationIds(openApiDocument) {
  return Object.values(openApiDocument?.paths ?? {}).flatMap((pathItem) =>
    Object.values(pathItem ?? {}).flatMap((operation) =>
      operation?.operationId ? [operation.operationId] : []
    )
  ).sort();
}
