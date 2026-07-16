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
    expect(failJobSection).toContain("options?.retrydelayms");
    expect(failJobSection).toContain("input.workerjobs.failworkerjob");
    expect(failJobSection).toContain("retryafter");
    expect(failJobSection).toContain("input.workerjobs.deadletterworkerjob");
    expect(failJobSection).toContain("worker job moved to dead letter");
  });

  it("stops new work and releases unstarted claimed jobs during shutdown", () => {
    const runtime = readRuntime();

    expect(runtime).toContain("runlane({ kinds: [\"hard_delete\"]");
    expect(runtime).toContain("runlane({ kinds: [\"resource_operation\"]");
    expect(runtime).toContain("runlane({ kinds: [\"upload_session_finalization\"]");
    expect(runtime).toContain("runlane({ kinds: [\"publication\"]");
    expect(runtime).toContain("runlane({ kinds: [\"source_file_processing\"]");
    expect(runtime).toContain("await promise.all([ runlane({ kinds: [\"hard_delete\"]");
    expect(runtime).toContain("input.role === \"upload_session_finalization\"");
    expect(runtime).toContain("workerconfig.harddeleteconcurrency");
    expect(runtime).toContain("databasebatchsize: workerconfig.harddeletedatabasebatchsize");
    expect(runtime).toContain("harddeleteobjectbatchsize");
    expect(runtime).toContain("workerconfig.sourcefileconcurrency");
    expect(runtime).toContain("workerconfig.claimbatchsize");
    expect(runtime).toContain("await readeffectiveruntimesettings()");
    expect(runtime).toContain("uploadgeneration.generationbatchsize");
    expect(runtime).toContain("uploadgeneration.fileprocessingconcurrency");
    expect(runtime).toContain("if (signal.aborted)");
    expect(runtime).toContain("releaseworkerjobs");
    expect(runtime).toContain("input.workerjobs.releaseworkerjob");
    expect(runtime).toContain("skippeditems");
  });

  it("claims destructive work, mutations, and upload finalization before publication and source processing", () => {
    const runtime = readRuntime();
    const claimSection = runtime.slice(
      runtime.indexOf("async function claimworkerjobsfortick"),
      runtime.indexOf("async function processworkerjob")
    );

    expect(claimSection.indexOf("kinds: [\"hard_delete\"]")).toBeGreaterThanOrEqual(0);
    expect(claimSection.indexOf("kinds: [\"publication\"]")).toBeGreaterThan(
      claimSection.indexOf("kinds: [\"upload_session_finalization\"]")
    );
    expect(claimSection.indexOf("kinds: [\"upload_session_finalization\"]")).toBeGreaterThan(
      claimSection.indexOf("kinds: [\"resource_operation\"]")
    );
    expect(claimSection.indexOf("kinds: [\"resource_operation\"]")).toBeGreaterThan(
      claimSection.indexOf("kinds: [\"hard_delete\"]")
    );
    expect(claimSection.indexOf("kinds: [\"source_file_processing\"]")).toBeGreaterThan(
      claimSection.indexOf("kinds: [\"publication\"]")
    );
    expect(claimSection).toContain("math.min(input.workerconfig.harddeleteconcurrency ?? 1, input.limit)");
    expect(claimSection).toContain("const publicationlimit = input.limit - harddeletejobs.length");
    expect(claimSection).toContain("math.min(1, afteroperations)");
    expect(claimSection).toContain(
      "const remaininglimit = input.limit - harddeletejobs.length - resourceoperationjobs.length - uploadfinalizationjobs.length - publicationjobs.length"
    );
  });

  it("contains unexpected resource-operation failures inside the claimed job", () => {
    const runtime = readRuntime();
    const section = runtime.slice(
      runtime.indexOf("async function processinternalresourceoperationjob"),
      runtime.indexOf("function readresourceoperationid")
    );

    expect(section).toContain("try {");
    expect(section).toContain("catch (error)");
    expect(section).toContain("resource_operation_failed");
    expect(section).toContain("await failjob(");
    expect(section).toContain("input.repositories.sourceresources?.failoperation");
  });

  it("passes runtime graph settings into source-file processing and publication", () => {
    const runtime = readRuntime();
    const compactRuntime = runtime.replace(/\s+/g, "");

    expect(runtime).toContain("const graphsettings = runtimesettings?.graph ?? resolvegraphconfig(input.config)");
    expect(compactRuntime).toContain("graphcandidatelimit:graphsettings.candidatelimit");
    expect(compactRuntime).toContain("graphpublicationshardsize:graphsettings.publicationshardsize");
    expect(compactRuntime).toContain("graphinsightenabled:graphsettings.insightenabled");
    expect(runtime).toContain("graph: graphsettings");
  });
});
