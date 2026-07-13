import assert from "node:assert/strict";
import test from "node:test";
import {
  matchAdminSourceFilesToSamples,
  readAdminSourceFileModelName,
  readAdminSourceFileId,
  readUploadSourceFileId
} from "../lib/source-file-contract.mjs";

test("reads source identities from upload and Admin response contracts", () => {
  assert.equal(readUploadSourceFileId({ sourceFileId: "source-file-upload" }), "source-file-upload");
  assert.equal(readUploadSourceFileId({ id: "source-file-admin" }), null);
  assert.equal(readAdminSourceFileId({ id: "source-file-admin" }), "source-file-admin");
  assert.equal(readAdminSourceFileId({ sourceFileId: "source-file-upload" }), null);
});

test("reads the model name from the persisted Admin source-file contract", () => {
  assert.equal(
    readAdminSourceFileModelName({ modelInvocationModelName: " model-v2 " }),
    "model-v2"
  );
  assert.equal(readAdminSourceFileModelName({ modelInvocationModelName: null }), null);
});

test("matches nested upload samples by their complete relative paths", () => {
  const files = [
    { id: "source-file-nested", relativePath: "group-01/segment-02/guide.md" },
    { id: "source-file-root", relativePath: "guide.md" }
  ];
  const samples = [
    { basename: "guide.md", relativePath: "group-01/segment-02/guide.md" }
  ];

  assert.deepEqual(matchAdminSourceFilesToSamples(files, samples), [files[0]]);
});
