import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RUNTIME_SERVICE_ORDER,
  createRuntimeServiceDefinitions,
  createRuntimeServiceSupervisor
} from "../lib/interleaved-runtime-services.mjs";

test("defines API and every independently controlled Worker runtime", () => {
  const definitions = createRuntimeServiceDefinitions("apps/api/runtime");

  assert.deepEqual(RUNTIME_SERVICE_ORDER, [
    "api",
    "source-worker",
    "publication-worker",
    "maintenance-worker"
  ]);
  for (const serviceName of RUNTIME_SERVICE_ORDER) {
    assert.ok(definitions[serviceName].entrypoint.endsWith(".mjs"));
  }
  assert.deepEqual(definitions.api.execArgv, []);
  assert.deepEqual(definitions["source-worker"].execArgv, [
    "--max-old-space-size=256"
  ]);
  assert.deepEqual(definitions["publication-worker"].execArgv, [
    "--max-old-space-size=512"
  ]);
  assert.deepEqual(definitions["maintenance-worker"].execArgv, []);
});

test("starts, verifies, stops, and restores independently controlled services", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "interleaved-runtime-"));
  const runtimeRoot = path.join(root, "runtime");
  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(runtimeRoot, { recursive: true });

  for (const definition of Object.values(
    createRuntimeServiceDefinitions(runtimeRoot)
  )) {
    fs.writeFileSync(
      definition.entrypoint,
      "setInterval(() => {}, 1000);\n",
      "utf8"
    );
  }

  const supervisor = createRuntimeServiceSupervisor({
    runtimeRoot,
    evidenceDir,
    cwd: root,
    env: {}
  });
  await supervisor.start("source-worker");
  assert.equal(supervisor.isRunning("source-worker"), true);
  assert.doesNotThrow(() => supervisor.assertRunning("source-worker"));

  const captured = supervisor.captureState();
  await supervisor.stop("source-worker");
  assert.equal(supervisor.isRunning("source-worker"), false);
  await supervisor.restore(captured);
  assert.equal(supervisor.isRunning("source-worker"), true);
  await supervisor.stopAll();
});
