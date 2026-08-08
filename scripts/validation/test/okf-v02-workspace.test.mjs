import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupOkfV02Workspace,
  createOkfV02RunOwnership,
  createOkfV02RunWorkspace,
  discoverLegacyOkfFixtures,
  discoverOfficialOkfFixtures,
  openOkfV02RunJournal,
  prepareOfficialOkfCheckout,
  recordOkfV02OwnedResource,
  stageOkfV02Fixtures,
  verifyFixtureFilesUnchanged
} from "../lib/okf-v02-workspace.mjs";

const PINNED_REVISION = "930b65fc3f5619d5d0591f88c72ebae8b848d60d";

test("official checkout preparation reports network and revision prerequisites", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "okf-v02-checkout-test-"));
  const workspace = await createOkfV02RunWorkspace({ temporaryRoot: parent, runId: "checkout-test" });
  try {
    await assert.rejects(
      prepareOfficialOkfCheckout({
        workspace,
        runGit: async () => {
          throw new Error("network unavailable");
        }
      }),
      /official OKF checkout prerequisite/u
    );
    await assert.rejects(
      prepareOfficialOkfCheckout({
        workspace,
        runGit: async (args) => args.includes("rev-parse") ? "wrong\n" : ""
      }),
      /pinned revision/u
    );
  } finally {
    await cleanupOkfV02Workspace(workspace);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("official fixture discovery enforces the 78/25/53 census", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-v02-census-test-"));
  const bundleRoot = path.join(root, "okf", "bundles");
  try {
    await writeFixtureSet(bundleRoot, 25, "reserved", (index) =>
      `${String(index).padStart(2, "0")}/${index % 2 === 0 ? "index.md" : "log.md"}`
    );
    await writeFixtureSet(bundleRoot, 53, "concept", (index) =>
      `concepts/concept-${String(index).padStart(2, "0")}.md`
    );
    await fs.writeFile(path.join(bundleRoot, "runtime.py"), "raise RuntimeError()\n");

    const fixtures = await discoverOfficialOkfFixtures(root);
    assert.equal(fixtures.markdown.length, 78);
    assert.equal(fixtures.reserved.length, 25);
    assert.equal(fixtures.concepts.length, 53);
    assert.equal(fixtures.nonMarkdown.length, 1);

    await fs.rm(fixtures.concepts[0].sourcePath);
    await assert.rejects(discoverOfficialOkfFixtures(root), /census changed/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy fixture discovery is read-only, safe, and requires 147 Markdown files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-v02-legacy-test-"));
  try {
    await writeFixtureSet(root, 146, "legacy", (index) =>
      `folder/file-${String(index).padStart(3, "0")}.md`
    );
    await assert.rejects(discoverLegacyOkfFixtures(root), /at least 147/u);
    await fs.writeFile(path.join(root, "folder", "file-146.md"), "# legacy 146\n");
    const selected = await discoverLegacyOkfFixtures(root);
    assert.equal(selected.length, 147);
    assert.equal(selected.every((entry) => entry.relativePath.endsWith(".md")), true);

    await assert.rejects(discoverLegacyOkfFixtures(path.join(root, "missing")), /does not exist/u);
    await fs.symlink(path.join(root, "folder", "file-000.md"), path.join(root, "linked.md"));
    await assert.rejects(discoverLegacyOkfFixtures(root), /symbolic link/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("staging verifies checksums, keeps sources immutable, and rejects collisions", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "okf-v02-stage-test-"));
  const sourceRoot = path.join(parent, "sources");
  const workspace = await createOkfV02RunWorkspace({ temporaryRoot: parent, runId: "stage-test" });
  try {
    await writeFixtureSet(sourceRoot, 200, "body", (index) =>
      `file-${String(index).padStart(3, "0")}.md`
    );
    const all = await discoverLegacyOkfFixtures(sourceRoot, { selectCount: 200 });
    const official = all.slice(0, 53);
    const legacy = all.slice(53);
    const staged = await stageOkfV02Fixtures({ workspace, official, legacy });

    assert.equal(staged.manifest.entries.length, 200);
    assert.equal(await verifyFixtureFilesUnchanged([...official, ...legacy]), true);
    await fs.writeFile(legacy[0].sourcePath, "changed\n");
    await assert.rejects(verifyFixtureFilesUnchanged([...official, ...legacy]), /checksum changed/u);

    await assert.rejects(stageOkfV02Fixtures({
      workspace,
      official: [...official.slice(0, 52), official[0]],
      legacy
    }), /duplicate|collision/u);
  } finally {
    await cleanupOkfV02Workspace(workspace);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("run journal resumes after interruption and cleanup removes only its workspace", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "okf-v02-resume-test-"));
  const sentinel = path.join(parent, "keep.txt");
  await fs.writeFile(sentinel, "keep\n");
  const workspace = await createOkfV02RunWorkspace({ temporaryRoot: parent, runId: "resume-test" });
  const journal = await openOkfV02RunJournal(workspace);
  await journal.update({ phase: "fixtures-staged", completedOperationIds: ["getDeveloperOpenApiHealth"] });
  const resumed = await openOkfV02RunJournal(workspace);

  assert.equal(resumed.state.phase, "fixtures-staged");
  assert.deepEqual(resumed.state.completedOperationIds, ["getDeveloperOpenApiHealth"]);
  await cleanupOkfV02Workspace(workspace);
  await assert.rejects(fs.access(workspace.root));
  await fs.access(sentinel);
  await fs.rm(parent, { recursive: true, force: true });
});

test("run ownership records every E2E resource family with run-owned IDs", () => {
  const ownership = createOkfV02RunOwnership("ownership-test");
  for (const [kind, value] of [
    ["knowledgeBaseIds", "kb-a"],
    ["openApiKeyIds", "key-a"],
    ["uploadSessionIds", "session-a"],
    ["webhookIds", "webhook-a"],
    ["operationIds", "operation-a"],
    ["searchIndexes", "index-a"],
    ["temporaryPaths", "/tmp/run-a"],
    ["evidenceArtifacts", "report-a"]
  ]) {
    recordOkfV02OwnedResource(ownership, kind, value);
  }
  assert.equal(Object.values(ownership.resources).every((values) => values.length === 1), true);
  assert.throws(
    () => recordOkfV02OwnedResource(ownership, "unknown", "value"),
    /resource kind/u
  );
});

async function writeFixtureSet(root, count, bodyPrefix, relativePathForIndex) {
  for (let index = 0; index < count; index += 1) {
    const file = path.join(root, relativePathForIndex(index));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `# ${bodyPrefix} ${index}\n`);
  }
}
