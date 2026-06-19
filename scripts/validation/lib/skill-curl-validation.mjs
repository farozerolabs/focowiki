import { spawn } from "node:child_process";

const HTTP_STATUS_MARKER = "__FOCOWIKI_HTTP_STATUS__:";
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export function selectSkillCommandInputs(generated = {}) {
  const inspectedPage = generated.inspectedPages?.find((page) => {
    const fileId = page.file?.fileId || page.frontmatter?.fileId;
    const pagePath = page.file?.path || page.path;
    return fileId && pagePath;
  });
  const searchEntry = generated.searchEntries?.find((entry) => entry.fileId || entry.path);
  const inventoryPage = generated.inventory?.find((entry) => entry.path?.startsWith("pages/") && entry.path.endsWith(".md"));
  const fileId =
    inspectedPage?.file?.fileId ||
    inspectedPage?.frontmatter?.fileId ||
    searchEntry?.fileId ||
    inventoryPage?.fileId ||
    "";
  const pagePath =
    inspectedPage?.file?.path ||
    inspectedPage?.path ||
    searchEntry?.path ||
    inventoryPage?.path ||
    "index.md";
  const graphPath =
    generated.inventory?.find((entry) => fileId && entry.path === `_graph/by-file/${fileId}.json`)?.path ||
    generated.inventory?.find((entry) => entry.path?.startsWith("_graph/by-file/") && entry.path.endsWith(".json"))?.path ||
    "_graph/index.md";
  const searchQuery =
    inspectedPage?.frontmatter?.title ||
    searchEntry?.title ||
    searchEntry?.metadata?.title ||
    "index";

  return { fileId, pagePath, graphPath, searchQuery };
}

export function buildSkillCurlCommandPlan(options = {}) {
  const baseUrl = normalizeSkillBaseUrl(options.demoBaseUrl);
  const inputs = {
    fileId: options.fileId || "",
    pagePath: options.pagePath || "index.md",
    graphPath: options.graphPath || "_graph/index.md",
    searchQuery: options.searchQuery || "index"
  };

  return [
    simpleCommand("health", "health", `${baseUrl}/health`, `curl -sS "$KNOWLEDGE_BASE_URL/health"`),
    simpleCommand(
      "knowledge-base-summary",
      "knowledge-base",
      `${baseUrl}/knowledge-base`,
      `curl -sS "$KNOWLEDGE_BASE_URL/knowledge-base"`
    ),
    getCommand(
      "tree-listing",
      "tree",
      `${baseUrl}/tree`,
      [
        ["parentPath", ""],
        ["limit", "50"]
      ],
      `curl -sS -G "$KNOWLEDGE_BASE_URL/tree" --data-urlencode "parentPath=" --data-urlencode "limit=50"`
    ),
    getCommand(
      "content-by-path-index",
      "content-by-path",
      `${baseUrl}/files/content`,
      [["path", "index.md"]],
      `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=index.md"`
    ),
    getCommand(
      "content-by-path-schema",
      "content-by-path",
      `${baseUrl}/files/content`,
      [["path", "schema.md"]],
      `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=schema.md"`
    ),
    getCommand(
      "search-files",
      "search",
      `${baseUrl}/search`,
      [
        ["query", inputs.searchQuery],
        ["limit", "10"]
      ],
      `curl -sS -G "$KNOWLEDGE_BASE_URL/search" --data-urlencode "query=${shellSafeDisplay(inputs.searchQuery)}" --data-urlencode "limit=10"`
    ),
    idCommand(
      "file-metadata-by-id",
      "file-metadata",
      `${baseUrl}/files/${encodeURIComponent(inputs.fileId)}`,
      inputs.fileId,
      `curl -sS "$KNOWLEDGE_BASE_URL/files/${shellSafeDisplay(inputs.fileId || "{fileId}")}"`
    ),
    idCommand(
      "content-by-id",
      "content-by-id",
      `${baseUrl}/files/${encodeURIComponent(inputs.fileId)}/content`,
      inputs.fileId,
      `curl -sS "$KNOWLEDGE_BASE_URL/files/${shellSafeDisplay(inputs.fileId || "{fileId}")}/content"`
    ),
    getCommand(
      "graph-by-path",
      "graph-by-path",
      `${baseUrl}/files/content`,
      [["path", inputs.graphPath]],
      `curl -sS -G "$KNOWLEDGE_BASE_URL/files/content" --data-urlencode "path=${shellSafeDisplay(inputs.graphPath)}"`
    ),
    idCommand(
      "related-files",
      "related-files",
      `${baseUrl}/files/${encodeURIComponent(inputs.fileId)}/related?limit=20`,
      inputs.fileId,
      `curl -sS "$KNOWLEDGE_BASE_URL/files/${shellSafeDisplay(inputs.fileId || "{fileId}")}/related?limit=20"`
    )
  ];
}

export function normalizeSkillBaseUrl(value) {
  const baseUrl = String(value || "").replace(/\/+$/, "");
  return baseUrl.endsWith("/agent/v1") ? baseUrl : `${baseUrl}/agent/v1`;
}

export async function validateSkillCurlCommands(options = {}) {
  const inputs = selectSkillCommandInputs(options.generated);
  const plan = buildSkillCurlCommandPlan({
    demoBaseUrl: options.demoBaseUrl,
    ...inputs
  });
  const commands = [];
  for (const command of plan) {
    commands.push(await executeSkillCurlCommand(command, {
      timeoutMs: options.requestTimeoutMs || DEFAULT_TIMEOUT_MS
    }));
  }
  const summary = summarizeSkillCommandResults(commands);
  return { inputs, commands, summary };
}

export function summarizeSkillCommandResults(commands) {
  const summary = {
    total: commands.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    leaked: 0,
    identifierContinuityPassed: 0,
    identifierContinuityFailed: 0
  };

  for (const command of commands) {
    if (command.skipped) {
      summary.skipped += 1;
    } else if (command.ok) {
      summary.passed += 1;
    } else {
      summary.failed += 1;
    }
    if (command.leakDetected) summary.leaked += 1;
    if (command.identifierContinuity) summary.identifierContinuityPassed += 1;
    if (!command.skipped && command.requiresIdentifierContinuity && !command.identifierContinuity) {
      summary.identifierContinuityFailed += 1;
    }
  }

  return summary;
}

async function executeSkillCurlCommand(command, options) {
  if (command.skipReason) {
    return {
      ...baseResult(command),
      skipped: true,
      ok: false,
      errorCode: "SKIPPED",
      errorMessage: command.skipReason
    };
  }

  const startedAt = Date.now();
  const result = await runCurl([...command.args, "-w", `\n${HTTP_STATUS_MARKER}%{http_code}`], options);
  const latencyMs = Date.now() - startedAt;
  const parsed = parseCurlOutput(result.stdout || "");
  const stderr = String(result.stderr || "").slice(0, 240);
  const responseShape = summarizeResponseShape(parsed.data);
  const leakDetected = hasUnsafeSkillOutput(`${parsed.body}\n${stderr}`);
  const identifierContinuity = hasReusableIdentifier(parsed.data);
  const ok =
    !result.error &&
    result.status === 0 &&
    parsed.httpStatus >= 200 &&
    parsed.httpStatus < 300 &&
    parsed.validJson &&
    !leakDetected &&
    (!command.requiresIdentifierContinuity || identifierContinuity);

  return {
    ...baseResult(command),
    ok,
    skipped: false,
    httpStatus: parsed.httpStatus,
    latencyMs,
    responseShape,
    identifierContinuity,
    requiresIdentifierContinuity: command.requiresIdentifierContinuity,
    leakDetected,
    errorCode: ok ? null : errorCodeForFailure(result, parsed, leakDetected, command, identifierContinuity),
    errorMessage: ok ? "" : safeErrorMessage(result, parsed, stderr)
  };
}

function runCurl(args, options) {
  return new Promise((resolve) => {
    const child = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status: 1, error, stdout, stderr });
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        status,
        error: timedOut ? Object.assign(new Error("curl command timed out"), { code: "ETIMEDOUT" }) : null,
        stdout,
        stderr
      });
    });
  });
}

function boundedAppend(current, chunk) {
  const next = `${current}${chunk.toString("utf8")}`;
  if (next.length <= MAX_CAPTURE_BYTES) return next;
  return next.slice(0, MAX_CAPTURE_BYTES);
}

function baseResult(command) {
  return {
    name: command.name,
    category: command.category,
    command: command.displayCommand,
    requiresIdentifierContinuity: Boolean(command.requiresIdentifierContinuity)
  };
}

function simpleCommand(name, category, url, displayCommand) {
  return {
    name,
    category,
    args: ["-sS", url],
    displayCommand,
    requiresIdentifierContinuity: category === "knowledge-base"
  };
}

function getCommand(name, category, url, query, displayCommand) {
  return {
    name,
    category,
    args: ["-sS", "-G", url, ...query.flatMap(([key, value]) => ["--data-urlencode", `${key}=${value}`])],
    displayCommand,
    requiresIdentifierContinuity: ["tree", "search", "content-by-path", "graph-by-path"].includes(category)
  };
}

function idCommand(name, category, url, fileId, displayCommand) {
  return {
    name,
    category,
    args: ["-sS", url],
    displayCommand,
    skipReason: fileId ? "" : "No reusable fileId was available from generated demo-visible files.",
    requiresIdentifierContinuity: true
  };
}

function parseCurlOutput(output) {
  const markerIndex = output.lastIndexOf(HTTP_STATUS_MARKER);
  const body = markerIndex === -1 ? output : output.slice(0, markerIndex).trim();
  const statusText = markerIndex === -1 ? "" : output.slice(markerIndex + HTTP_STATUS_MARKER.length).trim();
  const httpStatus = Number.parseInt(statusText, 10) || 0;
  try {
    return {
      body,
      httpStatus,
      validJson: true,
      data: body ? JSON.parse(body) : {}
    };
  } catch {
    return {
      body,
      httpStatus,
      validJson: false,
      data: null
    };
  }
}

function summarizeResponseShape(data) {
  if (Array.isArray(data)) return { type: "array", length: data.length };
  if (!data || typeof data !== "object") return { type: typeof data };
  const items = Array.isArray(data.items) ? data.items : [];
  const file = data.file && typeof data.file === "object" ? data.file : null;
  return {
    type: "object",
    keys: Object.keys(data).sort().slice(0, 12),
    itemCount: items.length,
    hasFileId: Boolean(data.fileId || file?.fileId || items.some((item) => item.fileId)),
    hasPath: Boolean(data.path || file?.path || items.some((item) => item.path)),
    hasContent: typeof data.content === "string" || typeof file?.content === "string",
    errorCode: data.error?.code || null
  };
}

function hasReusableIdentifier(data) {
  if (!data || typeof data !== "object") return false;
  const values = [data, data.file, data.knowledgeBase].filter((item) => item && typeof item === "object");
  if (values.some((item) => item.fileId || item.path || item.knowledgeBaseId)) return true;
  if (Array.isArray(data.items)) {
    return data.items.some((item) => item && typeof item === "object" && (item.fileId || item.path));
  }
  return false;
}

function hasUnsafeSkillOutput(text) {
  return /\/Users\/|\/home\/|\/private\/var\/|\/var\/folders\/|Authorization:\s*Bearer|Bearer\s+[A-Za-z0-9._~+/-]+|fwok_[A-Za-z0-9]|S3_SECRET_ACCESS_KEY|MODEL_API_KEY|knowledge-bases\/[^"'\s]+\/uploads\/|stack trace|SQLSTATE|REDIS_URL|redis:\/\/|redis[_-]?key/i.test(
    text
  );
}

function errorCodeForFailure(result, parsed, leakDetected, command, identifierContinuity) {
  if (result.error?.code === "ETIMEDOUT") return "TIMEOUT";
  if (leakDetected) return "UNSAFE_OUTPUT";
  if (!parsed.validJson) return "INVALID_JSON";
  if (parsed.httpStatus < 200 || parsed.httpStatus >= 300) return `HTTP_${parsed.httpStatus || "UNKNOWN"}`;
  if (command.requiresIdentifierContinuity && !identifierContinuity) return "MISSING_REUSABLE_IDENTIFIER";
  if (result.status !== 0) return `CURL_EXIT_${result.status}`;
  return "UNKNOWN_FAILURE";
}

function safeErrorMessage(result, parsed, stderr) {
  if (result.error) return result.error.message;
  if (parsed.data?.error?.code) return parsed.data.error.code;
  if (stderr) return stderr;
  return "Skill curl command did not satisfy validation requirements.";
}

function shellSafeDisplay(value) {
  return String(value).replace(/["$`\\]/g, "_");
}
