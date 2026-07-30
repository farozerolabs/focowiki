import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const host = "127.0.0.1";
const port = 4173;
const origin = `http://${host}:${port}`;
const server = spawn(
  process.execPath,
  [
    path.join(process.cwd(), "node_modules", "vitepress", "bin", "vitepress.js"),
    "preview",
    "docs",
    "--host",
    host,
    "--port",
    String(port)
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
);

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

try {
  await waitForServer();
  const browser = await chromium.launch();
  try {
    await validateExplorer(browser, {
      route: "/openapi/explorer",
      title: "API Explorer",
      knowledgeBaseTag: "Knowledge Bases",
      createSummary: "Create a knowledge base",
      deleteSummary: "Delete a knowledge base"
    });
    await validateExplorer(browser, {
      route: "/zh-CN/openapi/explorer",
      title: "API 交互文档",
      knowledgeBaseTag: "知识库",
      createSummary: "创建知识库",
      deleteSummary: "删除知识库"
    });
    await validateLoadingState(browser);
    await validateDarkTheme(browser);
    await validateFailureState(browser);
    await validateOrdinaryDocumentation(browser);
  } finally {
    await browser.close();
  }
  console.log("Swagger API Explorer browser validation passed.");
} finally {
  if (server.exitCode === null) {
    const exit = once(server, "exit");
    server.kill("SIGTERM");
    await exit;
  }
}

async function validateExplorer(
  browser,
  { route, title, knowledgeBaseTag, createSummary, deleteSummary }
) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  const tagId = knowledgeBaseTag.replace(/\s+/g, "_");
  const tagFragment = encodeURIComponent(knowledgeBaseTag);

  await page.goto(`${origin}${route}`, { waitUntil: "networkidle" });
  await page.locator(".swagger-ui").waitFor();
  await assertPageStructure(page, title);

  await page.locator(`#operations-tag-${tagId}`).click();
  const operation = page.locator(`#operations-${tagId}-createKnowledgeBase`);
  await operation.waitFor();
  await operation.locator(".opblock-summary").click();
  await operation.locator(".opblock-section-request-body").waitFor();
  await operation.locator(".responses-wrapper").waitFor();
  await page.waitForFunction(() => window.location.hash.length > 1);
  const deepLink = page.url();
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(page.url(), deepLink);
  await page.locator(".opblock.is-open").first().waitFor();

  const models = page.locator("section.models");
  await models.locator("button").first().click();
  await models.locator(".json-schema-2020-12, .model-container").first().waitFor();

  const filter = page.locator("#swagger-operation-search");
  for (const query of [
    createSummary,
    knowledgeBaseTag,
    "/openapi/v2/knowledge-bases",
    "POST",
    "createKnowledgeBase"
  ]) {
    await filter.fill(query);
    await page
      .locator(
        `.swagger-explorer-search-results a[href="#/${tagFragment}/createKnowledgeBase"]`
      )
      .waitFor();
  }
  await filter.fill("deleteKnowledgeBase");
  await page
    .locator(
      `.swagger-explorer-search-results a[href="#/${tagFragment}/deleteKnowledgeBase"]`
    )
    .click();
  await page
    .locator(`#operations-${tagId}-deleteKnowledgeBase.opblock.is-open`)
    .waitFor();
  await page
    .locator(`#operations-${tagId}-deleteKnowledgeBase .opblock-summary-description`)
    .getByText(deleteSummary, { exact: true })
    .waitFor();
  await filter.focus();
  const focusOutline = await filter.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  assert.notEqual(focusOutline.style, "none");
  assert.notEqual(focusOutline.width, "0px");

  const visibleSubmissionControls = page.locator(
    'button:visible:has-text("Try it out"), button:visible:has-text("Execute"), button:visible:has-text("Authorize")'
  );
  const submissionControlMarkup = await visibleSubmissionControls.evaluateAll((elements) =>
    elements.map((element) => element.outerHTML)
  );
  assert.deepEqual(
    await visibleSubmissionControls.allTextContents(),
    [],
    `Submission controls remain visible: ${submissionControlMarkup.join(", ")}`
  );

  for (const requestUrl of requests) {
    const url = new URL(requestUrl);
    assert.equal(url.origin, origin, `Explorer requested an external origin: ${requestUrl}`);
    assert.ok(!url.pathname.startsWith("/openapi/v2/"), `Explorer called the runtime API: ${requestUrl}`);
    assert.ok(!url.pathname.startsWith("/admin/"), `Explorer called the Admin API: ${requestUrl}`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".swagger-ui").waitFor();
  assert.ok(await page.locator(".swagger-explorer-shell").isVisible());
  const viewportFit = await page.evaluate(() => ({
    viewport: window.innerWidth,
    page: document.documentElement.scrollWidth,
    overflow: Array.from(document.querySelectorAll("body *"))
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        right: Math.round(element.getBoundingClientRect().right),
        width: Math.round(element.getBoundingClientRect().width)
      }))
  }));
  assert.ok(
    viewportFit.page <= viewportFit.viewport + 1,
    `Explorer overflows the mobile viewport: ${JSON.stringify(viewportFit)}`
  );
  const navigationToggle = page.locator(".VPNavBarHamburger");
  await navigationToggle.waitFor();
  await navigationToggle.click();
  await page.locator("#VPNavScreen").waitFor();
  await page.close();
}

async function assertPageStructure(page, title) {
  await page.getByRole("heading", { name: title, level: 1 }).waitFor();
  assert.ok((await page.locator(".opblock-tag").count()) > 0);
  assert.ok((await page.locator(".models").count()) > 0);
  assert.equal(await page.locator(".swagger-ui .info:visible").count(), 0);
  assert.equal(await page.locator(".swagger-ui .scheme-container:visible").count(), 0);
  await page.locator('a[download][href="/openapi/focowiki-openapi.json"]').waitFor();
}

async function validateOrdinaryDocumentation(browser) {
  const page = await browser.newPage();
  await page.goto(`${origin}/openapi/`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Developer OpenAPI", level: 1 }).waitFor();
  const resources = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name)
  );
  assert.equal(resources.some((resource) => /swagger/i.test(resource)), false);
  await page.goto(`${origin}/agent-integration/backend-adapter`, { waitUntil: "networkidle" });
  await page.locator("h1").waitFor();
  await page.goto(`${origin}/openapi/operations/create-knowledge-base`, {
    waitUntil: "networkidle"
  });
  await page.locator("h1").waitFor();
  await page.close();
}

async function validateFailureState(browser) {
  const page = await browser.newPage();
  await page.route("**/openapi/focowiki-openapi.json", (route) => route.abort());
  await page.goto(`${origin}/openapi/explorer`);
  await page.getByRole("alert").waitFor();
  await page.getByRole("link", { name: "Download the OpenAPI contract" }).waitFor();
  await page.close();
}

async function validateLoadingState(browser) {
  const page = await browser.newPage();
  await page.route("**/openapi/focowiki-openapi.json", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await page.goto(`${origin}/openapi/explorer`, { waitUntil: "domcontentloaded" });
  await page.getByRole("status").waitFor();
  await page.locator(".swagger-ui").waitFor();
  await page.close();
}

async function validateDarkTheme(browser) {
  const context = await browser.newContext({
    colorScheme: "dark",
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  await page.goto(`${origin}/openapi/explorer`, { waitUntil: "networkidle" });
  await page.locator(".swagger-ui").waitFor();
  assert.equal(
    await page.locator("html").evaluate((element) => element.classList.contains("dark-mode")),
    true
  );
  const tagDescriptionColor = await page
    .locator(".opblock-tag small")
    .first()
    .evaluate((element) => getComputedStyle(element).color);
  assert.notEqual(tagDescriptionColor, "rgb(59, 65, 81)");
  await context.close();
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`VitePress preview exited early.\n${serverOutput}`);
    }
    if (!serverOutput.includes("Built site served at")) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    try {
      const response = await fetch(origin);
      if (response.ok) {
        return;
      }
    } catch {
      // The preview server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`VitePress preview did not become ready.\n${serverOutput}`);
}
