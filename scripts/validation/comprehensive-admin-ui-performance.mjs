#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { performance as nodePerformance } from "node:perf_hooks";
import { loadEnvFile } from "node:process";
import { chromium } from "playwright";

import {
  ADMIN_UI_PERFORMANCE_ACTIONS,
  buildAdminUiPerformanceReport
} from "./lib/comprehensive-admin-ui-performance.mjs";

loadEnvironment();

const reportDirectory = requireReportDirectory();
const identity = readJson(path.join(reportDirectory, "performance-identity.json"));
const adminUiUrl = process.env.FOCOWIKI_ADMIN_UI_URL?.trim()
  || "http://127.0.0.1:43100";
const username = requiredEnvironment("ADMIN_USERNAME");
const password = requiredEnvironment("ADMIN_PASSWORD");
const officialKnowledgeBaseName = "General-purpose OKF 0.2 validation";
const officialKnowledgeBaseId = "knowledge-base-c56d4bcd-27fb-41dc-8f12-47b407157730";
const checkpointPath = path.join(reportDirectory, "admin-ui-performance.checkpoint.json");
const profiles = [
  { id: "desktop-en", locale: "en-US", viewport: { width: 1440, height: 1000 } },
  { id: "desktop-zh", locale: "zh-CN", viewport: { width: 1440, height: 1000 } },
  { id: "mobile-en", locale: "en-US", viewport: { width: 390, height: 844 } },
  { id: "mobile-zh", locale: "zh-CN", viewport: { width: 390, height: 844 } }
];
const browser = await chromium.launch({ headless: true });
const measuredProfiles = readProfileCheckpoint();

try {
  for (const profile of profiles) {
    if (measuredProfiles.some((item) => item.id === profile.id)) continue;
    measuredProfiles.push(await runProfile(profile));
    writeProfileCheckpoint(measuredProfiles);
  }
  const report = buildAdminUiPerformanceReport({
    identitySha256: identity.identitySha256,
    generatedAt: new Date().toISOString(),
    profiles: measuredProfiles
  });
  const reportPath = path.join(reportDirectory, "admin-ui-performance.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    reportPath,
    ...report.summary,
    evidenceSha256: report.evidenceSha256
  }, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  await browser.close();
}

async function runProfile(profile) {
  const context = await browser.newContext({
    locale: profile.locale,
    viewport: profile.viewport
  });
  await context.addInitScript(installPerformanceObservers);
  const page = await context.newPage();
  const failures = [];
  const consoleErrors = [];
  const pageErrors = [];
  page.on("requestfailed", (request) => failures.push({
    at: Date.now(),
    method: request.method(),
    path: safePath(request.url()),
    failure: request.failure()?.errorText ?? "request_failed"
  }));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({
      at: Date.now(),
      text: bounded(message.text(), 512)
    });
  });
  page.on("pageerror", (error) => pageErrors.push({
    at: Date.now(),
    text: bounded(error.message, 512)
  }));
  const actions = [];
  try {
    await page.goto(`${adminUiUrl}/`, { waitUntil: "domcontentloaded" });
    const memoryStartBytes = await readHeap(page);
    const labels = languageLabels(profile.locale);
    await measure("session.login", async () => {
      await page.getByLabel(labels.username, { exact: true }).fill(username);
      await page.getByLabel(labels.password, { exact: true }).fill(password);
      await page.getByRole("button", { name: labels.login, exact: true }).click();
      await page.getByRole("button", { name: labels.toggleSidebar, exact: true }).first()
        .waitFor({ state: "visible", timeout: 15_000 });
    });
    await measure("home.search", async () => {
      const search = page.getByLabel(labels.searchKnowledgeBases, { exact: true });
      if (!await search.isVisible()) {
        await page.getByRole("button", {
          name: labels.toggleSidebar,
          exact: true
        }).first().click();
      }
      await search.waitFor({ state: "visible", timeout: 5_000 });
      await search.fill(officialKnowledgeBaseId);
      await page.getByRole("button", {
        name: officialKnowledgeBaseName,
        exact: true
      }).waitFor({ state: "visible", timeout: 10_000 });
      await search.fill("");
    });
    await measure("home.open-knowledge-base", async () => {
      await page.getByRole("button", {
        name: officialKnowledgeBaseName,
        exact: true
      }).click();
      await page.locator('[data-slot="knowledge-base-detail-content"]')
        .waitFor({ state: "visible", timeout: 15_000 });
    });
    await measure("detail.processing", async () => {
      await clickSidebarAction(page, labels.fileProcessing, labels.toggleSidebar);
      await page.getByText(labels.fileProcessing, { exact: true }).first()
        .waitFor({ state: "visible", timeout: 10_000 });
    });
    await measure("detail.files", async () => {
      const treeSearch = page.getByPlaceholder(labels.fileTreeSearch, { exact: true });
      if (!await treeSearch.isVisible()) {
        await page.getByRole("button", {
          name: labels.toggleSidebar,
          exact: true
        }).first().click();
      }
      await treeSearch.waitFor({ state: "visible", timeout: 5_000 });
      const fileTreeScope = profile.viewport.width < 768
        ? page.locator('[data-mobile="true"]:visible')
        : page;
      const fileAction = fileTreeScope.getByRole("button", {
        name: "index.md",
        exact: true
      }).first();
      await fileAction.waitFor({ state: "visible", timeout: 10_000 });
      await fileAction.click();
      await page.locator('[data-slot="knowledge-base-detail-content"]')
        .waitFor({ state: "visible", timeout: 10_000 });
    });
    await measure("detail.settings", async () => {
      await clickSidebarAction(page, labels.settings, labels.toggleSidebar);
      await page.getByText(labels.indexMaintenance, { exact: true }).first()
        .waitFor({ state: "visible", timeout: 10_000 });
    });
    await measure("detail.back", async () => {
      await clickSidebarAction(page, labels.back, labels.toggleSidebar);
      await page.getByRole("button", { name: labels.toggleSidebar, exact: true }).first()
        .waitFor({ state: "visible", timeout: 10_000 });
    });
    await measure("home.openapi-keys", async () => {
      await clickSidebarAction(page, "OpenAPI keys", labels.toggleSidebar);
      await page.getByText(labels.openapiKeysTitle, { exact: true }).first()
        .waitFor({ state: "visible", timeout: 10_000 });
    });
    await measure("home.settings", async () => {
      await clickSidebarAction(page, labels.settings, labels.toggleSidebar);
      await page.locator('[role="tablist"]')
        .waitFor({ state: "visible", timeout: 15_000 });
    });
    for (const tab of labels.settingsTabs) {
      await measure(`settings.${tab.id}`, async () => {
        await page.getByRole("tab", { name: tab.label, exact: true }).click();
        await page.getByRole("tab", { name: tab.label, exact: true })
          .waitFor({ state: "visible", timeout: 10_000 });
      });
    }
    await measure("locale.switch-and-restore", async () => {
      const alternate = profile.locale === "en-US" ? "Chinese" : "English";
      const restore = profile.locale === "en-US" ? "English" : "Chinese";
      await page.getByRole("button", { name: labels.language, exact: true }).click();
      await page.getByRole("menuitemradio", { name: alternate, exact: true }).click();
      const alternateButton = profile.locale === "en-US" ? "语言" : "Language";
      await page.getByRole("button", { name: alternateButton, exact: true }).click();
      await page.getByRole("menuitemradio", { name: restore, exact: true }).click();
      await page.getByRole("button", { name: labels.language, exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
    });
    const metrics = await readMetrics(page);
    const memoryEndBytes = await readHeap(page);
    const measuredActionIds = actions.map((action) => action.id);
    const missing = ADMIN_UI_PERFORMANCE_ACTIONS.filter((id) =>
      !measuredActionIds.includes(id));
    if (missing.length > 0) throw new Error(`${profile.id}: missing ${missing.join(", ")}`);
    return {
      id: profile.id,
      locale: profile.locale,
      viewport: profile.viewport,
      actions,
      page: {
        navigationDurationMs: round(metrics.navigation.duration),
        domContentLoadedMs: round(metrics.navigation.domContentLoadedEventEnd),
        loadEventMs: round(metrics.navigation.loadEventEnd),
        firstContentfulPaintMs: round(metrics.firstContentfulPaintMs),
        largestContentfulPaintMs: round(metrics.largestContentfulPaintMs),
        interactionLatencyMs: round(metrics.interactionLatencyMs),
        cumulativeLayoutShift: round(metrics.cumulativeLayoutShift, 6),
        longTaskCount: metrics.longTaskCount,
        longTaskDurationMs: round(metrics.longTaskDurationMs),
        transferredBytes: metrics.transferredBytes,
        resourceCount: metrics.resourceCount,
        failedRequestCount: failures.length,
        consoleErrorCount: consoleErrors.length,
        pageErrorCount: pageErrors.length,
        memoryStartBytes,
        memoryEndBytes,
        memoryPeakBytes: Math.max(memoryStartBytes, memoryEndBytes, metrics.memoryBytes),
        horizontalOverflow: metrics.horizontalOverflow
      }
    };
  } finally {
    await context.close();
  }

  async function measure(id, operation) {
    const startedAt = Date.now();
    const started = nodePerformance.now();
    const before = await readResourceSnapshot(page);
    let error = null;
    try {
      await operation();
      await page.waitForTimeout(100);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const after = await readResourceSnapshot(page);
    const layout = await readLayout(page);
    actions.push({
      id,
      ok: error === null,
      durationMs: round(nodePerformance.now() - started),
      transferredBytes: Math.max(0, after.transferredBytes - before.transferredBytes),
      resourceCount: Math.max(0, after.resourceCount - before.resourceCount),
      failedRequestCount: failures.filter((item) => item.at >= startedAt).length,
      horizontalOverflow: layout.horizontalOverflow,
      ...(error ? { safeError: bounded(error, 512) } : {})
    });
    if (error) throw new Error(`${profile.id}:${id}: ${error}`);
  }
}

async function clickSidebarAction(page, label, toggleLabel) {
  const action = page.getByRole("button", { name: label, exact: true }).first();
  if (await action.isVisible()) {
    await action.click();
    return;
  }
  const toggle = page.getByRole("button", { name: toggleLabel, exact: true }).first();
  await toggle.click();
  await action.waitFor({ state: "visible", timeout: 5_000 });
  await action.click();
}

async function readResourceSnapshot(page) {
  return page.evaluate(() => {
    const resources = performance.getEntriesByType("resource");
    return {
      resourceCount: resources.length,
      transferredBytes: resources.reduce((sum, entry) =>
        sum + (Number.isFinite(entry.transferSize) ? entry.transferSize : 0), 0)
    };
  });
}

async function readLayout(page) {
  return page.evaluate(() => ({
    horizontalOverflow:
      document.documentElement.scrollWidth > document.documentElement.clientWidth
  }));
}

async function readHeap(page) {
  return page.evaluate(() => Number.isFinite(performance.memory?.usedJSHeapSize)
    ? performance.memory.usedJSHeapSize
    : 0);
}

async function readMetrics(page) {
  return page.evaluate(() => {
    const telemetry = window.__focowikiPerformanceTelemetry;
    const navigation = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    const firstContentfulPaint = performance.getEntriesByName("first-contentful-paint")[0];
    const interactions = new Map();
    for (const event of telemetry.events) {
      if (!event.interactionId) continue;
      interactions.set(
        event.interactionId,
        Math.max(interactions.get(event.interactionId) ?? 0, event.duration)
      );
    }
    const interactionDurations = [...interactions.values()].sort((left, right) =>
      left - right);
    const interactionIndex = Math.max(
      0,
      Math.ceil(interactionDurations.length * 0.98) - 1
    );
    return {
      navigation: {
        duration: navigation?.duration ?? 0,
        domContentLoadedEventEnd: navigation?.domContentLoadedEventEnd ?? 0,
        loadEventEnd: navigation?.loadEventEnd ?? 0
      },
      firstContentfulPaintMs: firstContentfulPaint?.startTime ?? 0,
      largestContentfulPaintMs: telemetry.largestContentfulPaintMs,
      interactionLatencyMs: interactionDurations[interactionIndex] ?? 0,
      cumulativeLayoutShift: telemetry.layoutShifts
        .filter((entry) => !entry.hadRecentInput)
        .reduce((sum, entry) => sum + entry.value, 0),
      longTaskCount: telemetry.longTasks.length,
      longTaskDurationMs: telemetry.longTasks.reduce((sum, entry) =>
        sum + entry.duration, 0),
      transferredBytes: resources.reduce((sum, entry) =>
        sum + (Number.isFinite(entry.transferSize) ? entry.transferSize : 0), 0),
      resourceCount: resources.length,
      memoryBytes: Number.isFinite(performance.memory?.usedJSHeapSize)
        ? performance.memory.usedJSHeapSize
        : 0,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });
}

function installPerformanceObservers() {
  const telemetry = {
    events: [],
    layoutShifts: [],
    longTasks: [],
    largestContentfulPaintMs: 0
  };
  Object.defineProperty(window, "__focowikiPerformanceTelemetry", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: telemetry
  });
  const observe = (type, callback, options = {}) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    observer.observe({ type, buffered: true, ...options });
  };
  observe("largest-contentful-paint", (entries) => {
    telemetry.largestContentfulPaintMs = Math.max(
      telemetry.largestContentfulPaintMs,
      ...entries.map((entry) => entry.startTime)
    );
  });
  observe("layout-shift", (entries) => telemetry.layoutShifts.push(
    ...entries.slice(-1_000).map((entry) => ({
      value: entry.value,
      hadRecentInput: entry.hadRecentInput
    }))
  ));
  observe("longtask", (entries) => telemetry.longTasks.push(
    ...entries.slice(-1_000).map((entry) => ({ duration: entry.duration }))
  ));
  observe("event", (entries) => telemetry.events.push(
    ...entries.slice(-10_000).map((entry) => ({
      duration: entry.duration,
      interactionId: entry.interactionId
    }))
  ), { durationThreshold: 16 });
}

function languageLabels(locale) {
  const english = locale === "en-US";
  return {
    username: english ? "Username" : "账号",
    password: english ? "Password" : "密码",
    login: english ? "Log in" : "登录",
    language: english ? "Language" : "语言",
    searchKnowledgeBases: english ? "Search knowledge bases" : "搜索知识库",
    toggleSidebar: english ? "Toggle sidebar" : "切换侧边栏",
    fileProcessing: english ? "File processing" : "文件处理",
    fileTree: english ? "File tree" : "文件树",
    fileTreeSearch: english ? "Search files and folders" : "搜索文件和文件夹",
    settings: english ? "Settings" : "设置",
    indexMaintenance: english ? "Index maintenance" : "索引维护",
    back: english ? "Back" : "返回",
    openapiKeysTitle: "OpenAPI keys",
    settingsTabs: [
      ["rate-limits", english ? "API limits" : "API 限流"],
      ["worker", "Worker"],
      ["publication", english ? "Publication" : "发布"],
      ["graph", english ? "Graph" : "图关系"],
      ["maintenance", english ? "Maintenance" : "维护"],
      ["search", english ? "Search" : "搜索"],
      ["semantic", english ? "Semantic" : "语义搜索"],
      ["embeddings", english ? "Embeddings" : "向量模型"],
      ["rerankers", english ? "Rerankers" : "重排模型"],
      ["models", english ? "Models" : "模型"]
    ].map(([id, label]) => ({ id, label }))
  };
}

function requireReportDirectory() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY;
  if (!value
    || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(value)) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY is invalid");
  }
  return path.resolve(value);
}

function readProfileCheckpoint() {
  if (!fs.existsSync(checkpointPath)) return [];
  const checkpoint = readJson(checkpointPath);
  if (checkpoint.identitySha256 !== identity.identitySha256
    || !Array.isArray(checkpoint.profiles)) return [];
  const expected = new Map(profiles.map((profile) => [profile.id, profile]));
  return checkpoint.profiles.filter((profile) => {
    const definition = expected.get(profile?.id);
    return definition
      && profile.locale === definition.locale
      && profile.viewport?.width === definition.viewport.width
      && profile.viewport?.height === definition.viewport.height;
  });
}

function writeProfileCheckpoint(completedProfiles) {
  fs.writeFileSync(checkpointPath, `${JSON.stringify({
    identitySha256: identity.identitySha256,
    profiles: completedProfiles
  }, null, 2)}\n`, { mode: 0o600 });
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadEnvironment() {
  const envFile = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envFile)) loadEnvFile(envFile);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function safePath(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return "invalid-url";
  }
}

function bounded(value, maximum) {
  return String(value).slice(0, maximum);
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}
