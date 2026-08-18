#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  analyzeOkfMetadata,
  inspectOkfMarkdownFile,
  parseUploadedMarkdownSource
} from "../../packages/okf/src/index.ts";
import {
  buildCorpusExpectationLedger,
  buildSanitizedCorpusManifest
} from "./lib/comprehensive-corpus.mjs";
import {
  createOkfV02RunWorkspace,
  discoverLegacyOkfFixtures,
  discoverOfficialOkfFixtures,
  openOkfV02RunJournal,
  prepareOfficialOkfCheckout,
  stageOkfV02Fixtures,
  verifyFixtureFilesUnchanged
} from "./lib/okf-v02-workspace.mjs";

const reportDirectory = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR;
const legacyRoot = process.env.FOCOWIKI_LEGACY_CORPUS_DIR;
if (!reportDirectory || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(reportDirectory)) {
  throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory");
}
if (!legacyRoot) throw new Error("FOCOWIKI_LEGACY_CORPUS_DIR is required");

const workspace = await createOkfV02RunWorkspace({
  runId: "clr-b648eb2f",
  temporaryRoot: process.env.FOCOWIKI_COMPREHENSIVE_TEMP_ROOT
});
const journal = await openOkfV02RunJournal(workspace);
await prepareOfficialOkfCheckout({ workspace });
const official = await discoverOfficialOkfFixtures(workspace.checkoutRoot);
const legacy = await discoverLegacyOkfFixtures(legacyRoot, { maximumBytes: 10 * 1024 * 1024 });
const auditedOfficial = await auditFiles(official.concepts, "native-v02");
const auditedLegacy = await auditFiles(legacy, "legacy-v01");
const staged = await stageOkfV02Fixtures({
  workspace,
  official: auditedOfficial,
  legacy: auditedLegacy
});
await verifyFixtureFilesUnchanged([...official.allFiles, ...legacy]);
await journal.update({
  phase: "comprehensive-corpus-staged",
  fixtureCounts: {
    officialMarkdown: official.markdown.length,
    officialReserved: official.reserved.length,
    officialConcepts: auditedOfficial.length,
    legalCompatibility: auditedLegacy.length,
    staged: staged.stagedFiles.length
  }
});

const manifest = buildSanitizedCorpusManifest({
  official: auditedOfficial,
  legacy: auditedLegacy
});
const expectationLedger = buildCorpusExpectationLedger(manifest);
await fs.mkdir(reportDirectory, { recursive: true });
await fs.writeFile(path.join(reportDirectory, "corpus-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await fs.writeFile(path.join(reportDirectory, "corpus-expectation-ledger.json"), `${JSON.stringify(expectationLedger, null, 2)}\n`);
await fs.writeFile(path.join(reportDirectory, "corpus-workspace-private.json"), `${JSON.stringify({
  workspace,
  revision: await gitHead(workspace.checkoutRoot),
  officialCensus: {
    markdown: official.markdown.length,
    reserved: official.reserved.length,
    concepts: official.concepts.length,
    nonMarkdown: official.nonMarkdown.length
  },
  files: staged.stagedFiles.map((file) => ({
    ...file,
    sourcePath: file.path.startsWith("official/")
      ? auditedOfficial.find((item) => `official/${item.relativePath}` === file.path)?.sourcePath
      : auditedLegacy.find((item) => `legacy/${item.relativePath}` === file.path)?.sourcePath
  }))
}, null, 2)}\n`, { mode: 0o600 });

process.stdout.write(`${JSON.stringify({
  revision: await gitHead(workspace.checkoutRoot),
  official: auditedOfficial.length,
  legacy: auditedLegacy.length,
  staged: staged.stagedFiles.length,
  workspace: "<RUN_OWNED_TEMPORARY_WORKSPACE>"
})}\n`);

async function auditFiles(files, classification) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const audited = [];
  for (const file of files) {
    const bytes = await fs.readFile(file.sourcePath);
    const content = decoder.decode(bytes);
    const parsed = parseUploadedMarkdownSource({
      fileName: path.basename(file.relativePath),
      content
    });
    const analysis = analyzeOkfMetadata(parsed.metadata, {
      ownership: "source",
      markdownBody: parsed.body
    });
    if (classification === "native-v02") {
      inspectOkfMarkdownFile({ path: file.relativePath, content }, "normative");
    }
    audited.push({
      ...file,
      frontmatterReadable: parsed.metadata !== null,
      bodyReadable: typeof parsed.body === "string",
      metadataClassification: classification,
      advisoryDiagnosticCount: analysis.diagnostics.length
    });
  }
  return audited;
}

async function gitHead(root) {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => execFile(
    "git",
    ["-C", root, "rev-parse", "HEAD"],
    { encoding: "utf8" },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim())
  ));
}
