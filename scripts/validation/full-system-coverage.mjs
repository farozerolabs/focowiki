import fs from "node:fs";
import path from "node:path";
import { buildFullSystemCoverageManifest } from "./lib/full-system-coverage.mjs";
import { redactReportText } from "./lib/redaction.mjs";

const document = JSON.parse(
  fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8")
);
const manifest = buildFullSystemCoverageManifest({ openApiDocument: document });
const reportDir = path.resolve(
  process.env.FOCOWIKI_FULL_SYSTEM_REPORT_DIR ||
    process.env.FOCOWIKI_VALIDATION_REPORT_DIR ||
    "ReferenceDocs/validate-focowiki-full-system-e2e"
);

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(
  path.join(reportDir, "coverage-manifest.json"),
  `${redactReportText(JSON.stringify(manifest, null, 2))}\n`
);

console.log(
  JSON.stringify({
    developerOpenApiOperations: manifest.developerOpenApi.actualCount,
    adminUiFlows: manifest.adminUi.count,
    adminApiRouteFamilies: manifest.adminApi.count,
    workerJobKinds: manifest.worker.count,
    runtimeSettingsGroups: manifest.runtimeSettings.count,
    generatedOutputFamilies: manifest.generatedOutput.count
  })
);
