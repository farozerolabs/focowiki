import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  createLifecycleHttpClient
} from "./lib/interleaved-lifecycle-api.mjs";

loadLocalEnv();
const proofPath = requiredEnv("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE");
const manifest = JSON.parse(fs.readFileSync(proofPath, "utf8"));
const runId = manifest?.proof?.runId;
const filesystemScope = manifest?.proof?.filesystemScope;
if (
  !/^svnext-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u.test(runId ?? "")
  || path.dirname(proofPath) !== filesystemScope
) {
  throw new Error("Validation target requires an exact storage-vNext run proof.");
}

const admin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`
});
const developer = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`
});
const origin = requiredEnv("ADMIN_PUBLIC_ORIGIN");
await admin.json("/admin/api/login", {
  method: "POST",
  headers: { origin },
  json: {
    username: requiredEnv("ADMIN_USERNAME"),
    password: requiredEnv("ADMIN_PASSWORD")
  }
});

let keyId = null;
try {
  const credential = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin },
    json: { name: `storage-vnext-${runId}` },
    expectedStatus: 201
  });
  keyId = credential.key.id;
  developer.authorization = `Bearer ${credential.oneTimeKey.rawKey}`;
  const response = await developer.json("/openapi/v2/knowledge-bases", {
    method: "POST",
    headers: {
      "idempotency-key": `${runId}-integrated-target`
    },
    json: {
      name: `Storage vNext ${runId} integrated target`,
      description: "Run-owned integrated validation target"
    },
    expectedStatus: 201
  });
  const knowledgeBase = response.knowledgeBase ?? response;
  const targetPath = path.join(filesystemScope, "validation-target.json");
  fs.writeFileSync(targetPath, `${JSON.stringify({
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    knowledgeBase: {
      id: knowledgeBase.knowledgeBaseId,
      resourceRevision: knowledgeBase.resourceRevision,
      name: `Storage vNext ${runId} integrated target`
    },
    openApiCredential: {
      id: credential.key.id,
      rawKey: credential.oneTimeKey.rawKey
    }
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    runId,
    targetPath,
    knowledgeBaseId: knowledgeBase.knowledgeBaseId,
    resourceRevision: knowledgeBase.resourceRevision,
    openApiKeyId: credential.key.id
  }, null, 2)}\n`);
} catch (error) {
  if (keyId) {
    await admin.request(`/admin/api/openapi-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
      headers: { origin }
    }).catch(() => undefined);
  }
  throw error;
} finally {
  await admin.request("/admin/api/logout", {
    method: "POST",
    headers: { origin }
  }).catch(() => undefined);
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
