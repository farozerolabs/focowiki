#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const operation = process.argv[2];
if (operation !== "create" && operation !== "delete") {
  throw new Error("Usage: comprehensive-temporary-openapi-key.mjs <create|delete>");
}

const environment = readEnvironmentFile(path.resolve(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_ENV_FILE")
));
const authorizationPath = safeTemporaryPath(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_AUTHORIZATION_FILE")
);
const metadataPath = safeTemporaryPath(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_KEY_METADATA_FILE")
);
const client = createAdminClient({
  baseUrl: process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_API_BASE_URL?.trim()
    || "http://127.0.0.1:43000",
  origin: requiredValue(environment, "ADMIN_PUBLIC_ORIGIN")
});

await client.json("/admin/api/login", {
  method: "POST",
  json: {
    username: requiredValue(environment, "ADMIN_USERNAME"),
    password: requiredValue(environment, "ADMIN_PASSWORD")
  }
});

if (operation === "create") {
  if (fs.existsSync(authorizationPath) || fs.existsSync(metadataPath)) {
    throw new Error("Comprehensive temporary OpenAPI key files already exist");
  }
  const created = await client.json("/admin/api/openapi-keys", {
    method: "POST",
    json: { name: `Comprehensive search ${Date.now()}` },
    expectedStatus: 201
  });
  if (!created.key?.id || !created.oneTimeKey?.rawKey) {
    throw new Error("Comprehensive temporary OpenAPI key response is incomplete");
  }
  fs.writeFileSync(authorizationPath, `Bearer ${created.oneTimeKey.rawKey}\n`, {
    mode: 0o600,
    flag: "wx"
  });
  fs.writeFileSync(metadataPath, `${JSON.stringify({ keyId: created.key.id })}\n`, {
    mode: 0o600,
    flag: "wx"
  });
  fs.chmodSync(authorizationPath, 0o600);
  fs.chmodSync(metadataPath, 0o600);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    operation,
    keyIdSha256: sha256(created.key.id)
  })}\n`);
} else {
  if (!fs.existsSync(metadataPath)) {
    throw new Error("Comprehensive temporary OpenAPI key metadata is unavailable");
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (typeof metadata.keyId !== "string" || metadata.keyId === "") {
    throw new Error("Comprehensive temporary OpenAPI key metadata is invalid");
  }
  await client.json(`/admin/api/openapi-keys/${encodeURIComponent(metadata.keyId)}`, {
    method: "DELETE"
  });
  fs.rmSync(authorizationPath, { force: true });
  fs.rmSync(metadataPath, { force: true });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    operation,
    keyIdSha256: sha256(metadata.keyId),
    temporaryFilesRemoved: !fs.existsSync(authorizationPath) && !fs.existsSync(metadataPath)
  })}\n`);
}

function createAdminClient(input) {
  let cookie = "";
  return {
    async json(pathname, options = {}) {
      const response = await fetch(new URL(pathname, `${input.baseUrl}/`), {
        method: options.method ?? "GET",
        headers: {
          origin: input.origin,
          ...(cookie ? { cookie } : {}),
          ...(options.json === undefined ? {} : { "content-type": "application/json" })
        },
        body: options.json === undefined ? undefined : JSON.stringify(options.json)
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0] ?? "";
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      const expectedStatus = options.expectedStatus ?? 200;
      if (response.status !== expectedStatus) {
        throw new Error(`Comprehensive temporary OpenAPI key request failed: ${response.status}`);
      }
      return body;
    }
  };
}

function readEnvironmentFile(filePath) {
  const values = new Map();
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function safeTemporaryPath(value) {
  const resolved = path.resolve(value);
  if (!resolved.startsWith("/private/tmp/") && !resolved.startsWith("/tmp/")) {
    throw new Error("Comprehensive temporary OpenAPI key files must stay in a temporary directory");
  }
  return resolved;
}

function requiredValue(values, name) {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`${name} is required in the validation environment file`);
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
