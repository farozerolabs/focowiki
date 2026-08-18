#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { assertSafeStagedArtifacts } from "./lib/comprehensive-release-staging.mjs";

const staged = git(["diff", "--cached", "--name-only", "-z"])
  .stdout.split("\0")
  .filter(Boolean);
const artifacts = staged.map((artifactPath) => {
  const ignored = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--quiet", "--", artifactPath],
    { encoding: "utf8" }
  ).status === 0;
  return {
    path: artifactPath,
    ignored,
    content: git(["show", `:${artifactPath}`], 2 * 1024 * 1024).stdout
  };
});

assertSafeStagedArtifacts(artifacts);
process.stdout.write(`${JSON.stringify({ checked: artifacts.length, safe: true })}\n`);

function git(args, maxBuffer = 1024 * 1024) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer });
  if (result.status !== 0) {
    throw new Error(`Git staging inspection failed: ${result.stderr.trim()}`);
  }
  return result;
}
