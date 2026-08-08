import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import {
  OKF_V02_REFERENCE_DIFFERENCES,
  inspectOkfBundleProfile,
  inspectOkfMarkdownFile,
} from "../../packages/okf/src/index.ts";
import {
  cleanupOkfV02Workspace,
  createOkfV02RunWorkspace,
  discoverLegacyOkfFixtures,
  discoverOfficialOkfFixtures,
  openOkfV02RunJournal,
  prepareOfficialOkfCheckout,
  stageOkfV02Fixtures,
  verifyFixtureFilesUnchanged
} from "./lib/okf-v02-workspace.mjs";
import { summarizeOkfV02FixtureRun } from "./lib/okf-v02-fixtures.mjs";

export async function runOkfV02E2E(input = {}) {
  if (!input.env) loadLocalEnv();
  const env = input.env ?? process.env;
  const mode = input.mode ?? "full";
  if (mode !== "full" && mode !== "prepare") {
    throw new Error("OKF 0.2 E2E mode must be full or prepare.");
  }
  const legacyCorpusRoot = env.OKF_V01_COMPAT_CORPUS_DIR?.trim();
  if (!legacyCorpusRoot) {
    throw new Error("Set OKF_V01_COMPAT_CORPUS_DIR to a read-only legacy Markdown corpus.");
  }
  const workspace = await createOkfV02RunWorkspace({
    runId: env.OKF_V02_E2E_RUN_ID?.trim() || `run-${Date.now()}`
  });
  const journal = await openOkfV02RunJournal(workspace);
  let official;
  let legacy;
  try {
    await prepareOfficialOkfCheckout({ workspace });
    await journal.update({ phase: "official-checkout-verified" });
    official = await discoverOfficialOkfFixtures(workspace.checkoutRoot);
    legacy = await discoverLegacyOkfFixtures(legacyCorpusRoot);
    const conformance = await validateOfficialFixtures(official);
    const staged = await stageOkfV02Fixtures({
      workspace,
      official: official.concepts,
      legacy
    });
    await journal.update({
      phase: "fixtures-staged",
      fixtureCounts: {
        officialMarkdown: official.markdown.length,
        officialReserved: official.reserved.length,
        officialConcepts: official.concepts.length,
        officialNonMarkdown: official.nonMarkdown.length,
        legacy: legacy.length,
        staged: staged.manifest.entries.length
      },
      conformance
    });

    if (mode === "full") {
      const { runOkfV02RuntimeE2E } = await import("./lib/okf-v02-runtime-e2e.mjs");
      await runOkfV02RuntimeE2E({
        env,
        workspace,
        journal,
        official,
        legacy,
        staged
      });
    }

    await verifyFixtureFilesUnchanged([...official.allFiles, ...legacy]);
    await journal.update({ phase: mode === "full" ? "runtime-verified" : "fixtures-verified" });
    return summarizeOkfV02FixtureRun({
      runId: workspace.runId,
      ownedResources: journal.state.ownership.resources
    });
  } finally {
    if (official && legacy) {
      await verifyFixtureFilesUnchanged([...official.allFiles, ...legacy]);
    }
    await cleanupOkfV02Workspace(workspace);
  }
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";
  if (existsSync(envFile)) loadEnvFile(envFile);
}

async function validateOfficialFixtures(official) {
  const bundle = await Promise.all(official.markdown.map(async (entry) => ({
    path: entry.relativePath,
    content: await fs.readFile(entry.sourcePath, "utf8")
  })));
  const allowedReferenceDifferences = new Set(
    OKF_V02_REFERENCE_DIFFERENCES.map((difference) =>
      `${difference.path.replace(/^okf\/bundles\//u, "")}:${difference.ruleId}`
    )
  );
  const blockingBundleIssues = inspectOkfBundleProfile(bundle, "normative")
    .filter((issue) => issue.disposition === "blocking");
  if (blockingBundleIssues.some((issue) =>
    !allowedReferenceDifferences.has(`${issue.path}:${issue.ruleId}`)
  )) {
    throw new Error("The pinned official bundle has an unexplained conformance difference.");
  }
  for (const expected of allowedReferenceDifferences) {
    if (!blockingBundleIssues.some((issue) => `${issue.path}:${issue.ruleId}` === expected)) {
      throw new Error("The pinned official conformance difference baseline changed.");
    }
  }
  let reservedIssueCount = 0;
  for (const entry of official.reserved) {
    const file = bundle.find((candidate) => candidate.path === entry.relativePath);
    const issues = inspectOkfMarkdownFile(file, "normative");
    const blocking = issues.filter((issue) => issue.disposition === "blocking");
    if (blocking.some((issue) =>
      !allowedReferenceDifferences.has(`${issue.path}:${issue.ruleId}`)
    )) {
      throw new Error("The pinned official reserved Markdown has an unexplained conformance difference.");
    }
    reservedIssueCount += issues.length;
  }
  return {
    bundleValidated: true,
    reservedValidated: official.reserved.length,
    reservedIssueCount,
    pinnedReferenceDifferenceCount: blockingBundleIssues.length
  };
}

async function main() {
  const mode = process.argv[2] === "prepare" ? "prepare" : "full";
  const summary = await runOkfV02E2E({ mode });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
