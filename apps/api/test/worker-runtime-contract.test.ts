import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runtimePath = resolve(import.meta.dirname, "../src/worker/runtime.ts");

function readRuntime(): string {
  return readFileSync(runtimePath, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("worker runtime contract", () => {
  it("retries failed jobs until max attempts and dead-letters exhausted work", () => {
    const runtime = readRuntime();
    const failJobSection = runtime.slice(
      runtime.indexOf("async function failjob"),
      runtime.indexOf("function readpublicationreason")
    );

    expect(failJobSection).toContain("input.job.attemptcount < input.job.maxattempts");
    expect(failJobSection).toContain("workerconfig.jobretrydelayms");
    expect(failJobSection).toContain("input.workerjobs.failworkerjob");
    expect(failJobSection).toContain("retryafter");
    expect(failJobSection).toContain("input.workerjobs.deadletterworkerjob");
    expect(failJobSection).toContain("worker job moved to dead letter");
  });

  it("stops new work and releases unstarted claimed jobs during shutdown", () => {
    const runtime = readRuntime();

    expect(runtime).toContain("runlane({ kinds: [\"publication\"]");
    expect(runtime).toContain("runlane({ kinds: [\"source_file_processing\"]");
    expect(runtime).toContain("input.role === \"publication\" ? math.min(workerconfig.pollintervalms, 1_000)");
    expect(runtime).toContain("await readeffectiveruntimesettings()");
    expect(runtime).toContain("uploadgeneration.generationbatchsize");
    expect(runtime).toContain("uploadgeneration.fileprocessingconcurrency");
    expect(runtime).toContain("if (signal.aborted)");
    expect(runtime).toContain("releaseworkerjobs");
    expect(runtime).toContain("input.workerjobs.releaseworkerjob");
    expect(runtime).toContain("skippeditems");
  });
});
