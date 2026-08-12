import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDockerLiveFaultServiceStartArguments
} from "../lib/comprehensive-docker-live-fault-runtime.mjs";

test("restarts an existing fault target without starting transitive dependencies", () => {
  assert.deepEqual(
    buildDockerLiveFaultServiceStartArguments("source-worker"),
    ["up", "--no-deps", "-d", "source-worker"]
  );
});

test("rejects an unsafe Docker Compose service name", () => {
  assert.throws(
    () => buildDockerLiveFaultServiceStartArguments("source-worker;down"),
    /invalid Docker Compose service/iu
  );
});
