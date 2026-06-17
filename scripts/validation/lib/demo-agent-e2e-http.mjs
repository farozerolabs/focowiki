import fs from "node:fs";

export async function requestJson(url, options = {}) {
  const response = await request(url, options);
  const text = await response.text();
  const data = text ? parseJson(text, url) : {};
  if (!response.ok && !options.allowError) {
    throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}: ${extractSafeError(data)}`);
  }
  return { response, data };
}

export async function requestText(url, options = {}) {
  const response = await request(url, options);
  const text = await response.text();
  if (!response.ok && !options.allowError) {
    throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}: ${text.slice(0, 160)}`);
  }
  return { response, text };
}

export async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    return await fetch(url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function jsonHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    ...extra
  };
}

export function bearerHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    ...extra
  };
}

export function appendQuery(baseUrl, query = {}) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function markdownFormData(samples) {
  const form = new FormData();
  for (const sample of samples) {
    const bytes = fs.readFileSync(sample.filePath);
    form.append("files", new File([bytes], sample.basename, { type: "text/markdown" }));
  }
  return form;
}

export async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const startedAt = Date.now();
  let lastError = "";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await request(url, {
        timeoutMs: Math.min(intervalMs, 5_000),
        headers: options.headers,
        allowError: true
      });
      if (options.acceptStatus?.(response.status) || (response.status >= 200 && response.status < 500)) {
        return response;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${new URL(url).origin}: ${lastError}`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text, url) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${new URL(url).pathname}`);
  }
}

function extractSafeError(data) {
  if (data && typeof data === "object" && data.error && typeof data.error === "object") {
    return String(data.error.code || data.error.message || "unknown error");
  }
  return "unknown error";
}
