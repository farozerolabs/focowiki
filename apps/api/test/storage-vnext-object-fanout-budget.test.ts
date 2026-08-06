import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateStorageVnextObjectFanoutBudget
} from "../src/storage-vnext/ownership/object-fanout-budget.js";

describe("storage vNext generated object fan-out budget", () => {
  it("allows at most five prospective active generated objects per source", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 100,
      activeGeneratedObjectCount: 490,
      candidateGeneratedObjectCount: 500,
      candidateOnlyObjectCount: 10
    })).toMatchObject({ passed: true, maximumActiveObjects: 500 });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 100,
      activeGeneratedObjectCount: 490,
      candidateGeneratedObjectCount: 501,
      candidateOnlyObjectCount: 10
    })).toMatchObject({ passed: false, activeFanoutPassed: false });
  });

  it("allows candidate-only objects within twenty percent of active objects", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 200,
      activeGeneratedObjectCount: 500,
      candidateGeneratedObjectCount: 600,
      candidateOnlyObjectCount: 100
    })).toMatchObject({ passed: true, maximumCandidateOnlyObjects: 100 });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 200,
      activeGeneratedObjectCount: 500,
      candidateGeneratedObjectCount: 601,
      candidateOnlyObjectCount: 101
    })).toMatchObject({ passed: false, candidateRatioPassed: false });
  });

  it("validates initial rebuild fan-out without inventing a zero-active ratio", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 10,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 109,
      candidateOnlyObjectCount: 109
    })).toMatchObject({
      passed: true,
      candidateRatioPassed: true,
      maximumActiveObjects: 131
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 10,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 132,
      candidateOnlyObjectCount: 132
    })).toMatchObject({ passed: false, activeFanoutPassed: false });
  });

  it("allows only the fixed released-navigation overhead for an empty knowledge base", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 0,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 9,
      candidateOnlyObjectCount: 9
    })).toMatchObject({ passed: true, maximumActiveObjects: 9 });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 0,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 10,
      candidateOnlyObjectCount: 10
    })).toMatchObject({ passed: false, activeFanoutPassed: false });
  });

  it("budgets candidate-only objects for source files added after an empty root", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 8,
      activeSourceFileCount: 0,
      activeGeneratedObjectCount: 9,
      candidateGeneratedObjectCount: 109,
      candidateOnlyObjectCount: 109
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 131,
      maximumCandidateOnlyObjects: 131
    });
  });

  it("includes fixed released-navigation objects in the small-sample ceiling", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 9,
      activeSourceFileCount: 9,
      activeGeneratedObjectCount: 109,
      candidateGeneratedObjectCount: 24,
      candidateOnlyObjectCount: 2
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 131,
      maximumCandidateOnlyObjects: 22
    });
  });

  it("does not reject measured file-first completeness below the scale gate", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 10,
      activeSourceFileCount: 9,
      changedSourceFileCount: 1,
      activeGeneratedObjectCount: 104,
      candidateGeneratedObjectCount: 114,
      candidateOnlyObjectCount: 22
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 131,
      fileFirstCompletenessAllowanceUsed: true,
      candidateRatioPassed: true
    });
  });

  it("keeps the strict active ceiling at and above the scale gate", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 100,
      activeSourceFileCount: 99,
      changedSourceFileCount: 1,
      activeGeneratedObjectCount: 500,
      candidateGeneratedObjectCount: 501,
      candidateOnlyObjectCount: 1
    })).toMatchObject({
      passed: false,
      maximumActiveObjects: 500,
      fileFirstCompletenessAllowanceUsed: false,
      activeFanoutPassed: false
    });
  });

  it("allows measured fixed overhead across a small structurally shared release chain", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 9,
      activeSourceFileCount: 9,
      activeGeneratedObjectCount: 86,
      candidateGeneratedObjectCount: 24,
      candidateOnlyObjectCount: 2
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 131,
      maximumCandidateOnlyObjects: 18
    });
  });

  it("bounds changed-source candidate overhead above the twenty-percent baseline", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 9,
      activeSourceFileCount: 9,
      changedSourceFileCount: 2,
      activeGeneratedObjectCount: 93,
      candidateGeneratedObjectCount: 100,
      candidateOnlyObjectCount: 29
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 131,
      maximumCandidateOnlyObjects: 29,
      candidateChangeAllowanceUsed: true
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 9,
      activeSourceFileCount: 9,
      changedSourceFileCount: 2,
      activeGeneratedObjectCount: 93,
      candidateGeneratedObjectCount: 100,
      candidateOnlyObjectCount: 30
    })).toMatchObject({
      passed: false,
      candidateRatioPassed: false
    });
  });

  it("makes release validation reject an over-budget candidate before ready or activation", () => {
    const release = readFileSync(
      resolve(import.meta.dirname, "../src/storage-vnext/release/postgres-repository.ts"),
      "utf8"
    );
    expect(release).toContain("measureStorageVnextObjectFanout");
    expect(release).toContain("evaluateStorageVnextObjectFanoutBudget");
    expect(release).toMatch(
      /recordCandidateValidation[\s\S]*objectFanout[\s\S]*if \(!objectFanout\.passed\)[\s\S]*return false/u
    );
    const fanout = readFileSync(
      resolve(import.meta.dirname, "../src/storage-vnext/ownership/object-fanout-budget.ts"),
      "utf8"
    );
    expect(fanout).toMatch(
      /retained\.knowledge_base_id\s*=\s*\$\{input\.knowledgeBaseId\}/u
    );
  });
});
