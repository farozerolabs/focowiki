import { resolve } from "node:path";
import { bootstrapMeilisearchKeys } from
  "./infrastructure/meilisearch/meilisearch-key-bootstrap.js";
import { ensureBundledOpenSearchSecurityAssets } from
  "./infrastructure/opensearch/opensearch-security-assets.js";
import { loadDeploymentSecret } from "./security/runtime-secrets.js";

const provider = process.env.SEARCH_PROVIDER?.trim().toLowerCase();

if (provider === "meilisearch") {
  const secretDirectory = resolve(
    process.env.MEILI_SECRET_DIR ?? "/app/runtime-secrets"
  );
  loadDeploymentSecret({ directory: secretDirectory });
  const result = await bootstrapMeilisearchKeys({
    endpoint: process.env.MEILI_HOST ?? "http://127.0.0.1:7700",
    masterKey: process.env.MEILI_MASTER_KEY ?? "",
    indexPrefix: process.env.SEARCH_INDEX_PREFIX ?? "focowiki",
    secretDirectory,
    providedApiKey: process.env.MEILI_API_KEY,
    providedMetricsApiKey: process.env.MEILI_METRICS_API_KEY,
    maxAttempts: 60,
    retryDelayMs: 1_000
  });
  writeReady({ provider, source: result.source });
} else if (provider === "opensearch") {
  if (process.env.BUNDLED_OPENSEARCH_SECURITY_ENABLED !== "true") {
    writeReady({ provider, source: "not-required" });
  } else {
    const result = ensureBundledOpenSearchSecurityAssets({
      securityDirectory: resolve(
        process.env.OPENSEARCH_SECURITY_DIR ?? "/app/opensearch-security"
      ),
      runtimeSecretDirectory: resolve(
        process.env.OPENSEARCH_SECRET_DIR ?? "/app/runtime-secrets"
      ),
      adminPassword: process.env.OPENSEARCH_ADMIN_PASSWORD ?? "",
      indexPrefix: process.env.SEARCH_INDEX_PREFIX ?? "focowiki",
      runtimeUsername:
        process.env.OPENSEARCH_RUNTIME_USERNAME ?? "focowiki-runtime"
    });
    writeReady({ provider, source: result.source });
  }
} else {
  throw new Error("SEARCH_PROVIDER must be opensearch or meilisearch");
}

function writeReady(input: {
  provider: "meilisearch" | "opensearch";
  source: string;
}): void {
  process.stdout.write(`${JSON.stringify({ status: "ready", ...input })}\n`);
}
