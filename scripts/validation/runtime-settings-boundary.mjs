import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

loadLocalEnv();

const mode = process.argv[2] ?? "prepare";
const statePath = path.resolve(
  process.env.FOCOWIKI_RUNTIME_SETTINGS_STATE
    ?? "/tmp/focowiki-runtime-settings-validation.json"
);
const reportPath = path.resolve(
  process.env.FOCOWIKI_RUNTIME_SETTINGS_REPORT
    ?? "ReferenceDocs/runtime-settings-boundary-report.json"
);
const baseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const origin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";

if (mode === "prepare") {
  await prepare();
} else if (mode === "verify") {
  await verifyAfterRestart();
} else {
  throw new Error(`Unsupported runtime settings validation mode: ${mode}`);
}

async function prepare() {
  const client = createClient();
  await login(client);
  const initial = await requestJson(client, "/admin/api/settings/runtime");
  assertPublicSettings(initial);

  const categories = [
    ["rateLimits", "/admin/api/settings/rate-limits"],
    ["worker", "/admin/api/settings/worker"],
    ["publication", "/admin/api/settings/publication"],
    ["uploadGeneration", "/admin/api/settings/upload-generation"],
    ["graph", "/admin/api/settings/graph"]
  ];
  const checks = [];

  for (const [key, pathname] of categories) {
    const current = initial.settings?.[key];
    assert(current && typeof current === "object", `Missing runtime setting category: ${key}`);

    const missing = await requestJson(client, pathname, {
      method: "PUT",
      body: {},
      expectedStatus: 400
    });
    assertValidationError(missing, `${key} missing-required`);
    checks.push({ category: key, case: "missing-required", status: 400 });

    const invalid = structuredClone(current);
    assert(
      replaceFirstPositiveInteger(invalid),
      `No numeric boundary field found for ${key}`
    );
    const invalidBody = await requestJson(client, pathname, {
      method: "PUT",
      body: invalid,
      expectedStatus: 400
    });
    assertValidationError(invalidBody, `${key} invalid-boundary`);
    checks.push({ category: key, case: "invalid-boundary", status: 400 });

    const valid = await requestJson(client, pathname, {
      method: "PUT",
      body: current,
      expectedStatus: 200
    });
    assert(
      stableJson(valid.settings?.[key]) === stableJson(current),
      `${key} save response did not return the persisted category`
    );
    checks.push({ category: key, case: "valid-current", status: 200 });
  }

  const persisted = await requestJson(client, "/admin/api/settings/runtime");
  assertPublicSettings(persisted);
  const state = {
    cookie: client.cookie,
    digest: snapshotDigest(persisted),
    modelFingerprints: (persisted.models ?? []).map((model) => model.apiKeyFingerprint).sort()
  };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  writeReport({
    kind: "runtime-settings-boundary",
    phase: "prepare",
    ok: true,
    categories: categories.map(([key]) => key),
    checks,
    sessionPersistedForRestart: Boolean(client.cookie),
    activeModelConfigured: Boolean(persisted.settings?.activeModel),
    modelCount: persisted.models?.length ?? 0
  });
}

async function verifyAfterRestart() {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const client = createClient(state.cookie);
  const health = await requestJson(client, "/healthz");
  assert(health.status === "ok", "Admin API health failed after restart");
  const persisted = await requestJson(client, "/admin/api/settings/runtime");
  assertPublicSettings(persisted);
  assert(snapshotDigest(persisted) === state.digest, "Runtime settings changed across restart");
  assert(
    stableJson((persisted.models ?? []).map((model) => model.apiKeyFingerprint).sort())
      === stableJson(state.modelFingerprints),
    "Model records changed across restart"
  );
  writeReport({
    kind: "runtime-settings-boundary",
    phase: "restart-verified",
    ok: true,
    health: "ok",
    existingSessionAccepted: true,
    settingsDurable: true,
    modelsDurable: true,
    activeModelConfigured: Boolean(persisted.settings?.activeModel),
    modelCount: persisted.models?.length ?? 0
  });
  fs.rmSync(statePath, { force: true });
}

function createClient(cookie = "") {
  return { cookie };
}

async function login(client) {
  await requestJson(client, "/admin/api/login", {
    method: "POST",
    body: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    },
    expectedStatus: 200
  });
  assert(client.cookie, "Admin login did not return a session cookie");
}

async function requestJson(client, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      ...(client.cookie ? { cookie: client.cookie } : {}),
      ...(options.method && options.method !== "GET" ? { origin } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const cookie = response.headers.get("set-cookie");
  if (cookie) client.cookie = cookie.split(";")[0] ?? client.cookie;
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  const expectedStatus = options.expectedStatus ?? 200;
  assert(
    response.status === expectedStatus,
    `${options.method ?? "GET"} ${pathname} returned ${response.status}, expected ${expectedStatus}`
  );
  return body;
}

function assertPublicSettings(body) {
  assert(body?.settings && Array.isArray(body.models), "Runtime settings response is incomplete");
  const serialized = JSON.stringify(body);
  assert(!serialized.includes('"apiKey":'), "Runtime settings response exposed a raw model API key field");
  for (const model of body.models) {
    assert(model.apiKeyFingerprint && !model.apiKey, "Runtime model response is not safely serialized");
  }
}

function assertValidationError(body, label) {
  assert(
    body?.error?.code === "RUNTIME_SETTINGS_VALIDATION_FAILED"
      && Array.isArray(body.error.issues)
      && body.error.issues.length > 0,
    `${label} did not return the stable validation error envelope`
  );
}

function snapshotDigest(body) {
  return createHash("sha256")
    .update(stableJson({ settings: body.settings, models: body.models }))
    .digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function replaceFirstPositiveInteger(value) {
  if (!value || typeof value !== "object") return false;
  for (const key of Object.keys(value)) {
    if (Number.isInteger(value[key]) && value[key] > 0) {
      value[key] = 0;
      return true;
    }
    if (replaceFirstPositiveInteger(value[key])) return true;
  }
  return false;
}

function writeReport(value) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  let phases = [];
  if (fs.existsSync(reportPath)) {
    const existing = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    phases = Array.isArray(existing.phases)
      ? existing.phases
      : existing.phase
        ? [{ ...existing, kind: undefined, phases: undefined }]
        : [];
  }
  phases = [
    ...phases.filter((phase) => phase.phase !== value.phase),
    { ...value, finishedAt: new Date().toISOString() }
  ];
  fs.writeFileSync(reportPath, `${JSON.stringify({
    kind: "runtime-settings-boundary",
    ok: phases.every((phase) => phase.ok),
    phases
  }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: value.ok, phase: value.phase, reportPath }));
}

function loadLocalEnv() {
  const envPath = path.resolve(".env");
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
