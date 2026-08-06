import { resolve } from "node:path";
import { bootstrapMeilisearchKeys } from "./infrastructure/meilisearch/meilisearch-key-bootstrap.js";
import { loadDeploymentSecret } from "./security/runtime-secrets.js";

const secretDirectory = resolve(
  process.env.MEILI_SECRET_DIR ?? "/app/runtime-secrets"
);
loadDeploymentSecret({ directory: secretDirectory });
const result = await bootstrapMeilisearchKeys({
  endpoint: process.env.MEILI_HOST ?? "http://127.0.0.1:7700",
  masterKey: process.env.MEILI_MASTER_KEY ?? "",
  indexPrefix: process.env.MEILI_INDEX_PREFIX ?? "focowiki",
  secretDirectory,
  providedApiKey: process.env.MEILI_API_KEY,
  providedMetricsApiKey: process.env.MEILI_METRICS_API_KEY,
  maxAttempts: 60,
  retryDelayMs: 1_000
});

process.stdout.write(
  `${JSON.stringify({ status: "ready", source: result.source })}\n`
);
