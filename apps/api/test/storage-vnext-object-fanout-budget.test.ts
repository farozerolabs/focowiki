import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateStorageVnextObjectFanoutBudget
} from "../src/storage-vnext/ownership/object-fanout-budget.js";

describe("storage vNext generated object fan-out budget", () => {
  it("adds fixed projection capacity to five prospective objects per source", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 100,
      activeGeneratedObjectCount: 957,
      candidateGeneratedObjectCount: 967,
      candidateOnlyObjectCount: 10
    })).toMatchObject({ passed: true, maximumActiveObjects: 967 });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 100,
      activeGeneratedObjectCount: 957,
      candidateGeneratedObjectCount: 968,
      candidateOnlyObjectCount: 10
    })).toMatchObject({ passed: false, activeFanoutPassed: false });
  });

  it("allows the navigation-profile overhead above twenty percent", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 200,
      activeGeneratedObjectCount: 500,
      candidateGeneratedObjectCount: 607,
      candidateOnlyObjectCount: 107
    })).toMatchObject({ passed: true, maximumCandidateOnlyObjects: 107 });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 200,
      activeGeneratedObjectCount: 500,
      candidateGeneratedObjectCount: 608,
      candidateOnlyObjectCount: 108
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
      maximumActiveObjects: 517
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 10,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 518,
      candidateOnlyObjectCount: 518
    })).toMatchObject({ passed: false, activeFanoutPassed: false });
  });

  it("allows the bounded sparse projection topology for a thirty-six-file rebuild", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 36,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 278,
      candidateOnlyObjectCount: 278
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 647,
      fileFirstCompletenessAllowanceUsed: true
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 36,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 648,
      candidateOnlyObjectCount: 648
    })).toMatchObject({ passed: false, activeFanoutPassed: false });
  });

  it("allows only the fixed released-navigation overhead for an empty knowledge base", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 0,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 19,
      candidateOnlyObjectCount: 19
    })).toMatchObject({ passed: true, maximumActiveObjects: 19 });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 0,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 20,
      candidateOnlyObjectCount: 20
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
      maximumActiveObjects: 507,
      maximumCandidateOnlyObjects: 507
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
      maximumActiveObjects: 512,
      maximumCandidateOnlyObjects: 29
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
      maximumActiveObjects: 517,
      fileFirstCompletenessAllowanceUsed: false,
      candidateRatioPassed: true
    });
  });

  it("keeps the strict active ceiling at and above the scale gate", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 100,
      activeSourceFileCount: 99,
      changedSourceFileCount: 1,
      activeGeneratedObjectCount: 967,
      candidateGeneratedObjectCount: 968,
      candidateOnlyObjectCount: 1
    })).toMatchObject({
      passed: false,
      maximumActiveObjects: 967,
      fileFirstCompletenessAllowanceUsed: true,
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
      maximumActiveObjects: 512,
      maximumCandidateOnlyObjects: 25
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
      maximumActiveObjects: 512,
      maximumCandidateOnlyObjects: 36,
      candidateChangeAllowanceUsed: true
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 9,
      activeSourceFileCount: 9,
      changedSourceFileCount: 2,
      activeGeneratedObjectCount: 93,
      candidateGeneratedObjectCount: 100,
      candidateOnlyObjectCount: 37
    })).toMatchObject({
      passed: false,
      candidateRatioPassed: false
    });
  });

  it("allows a bounded maintenance candidate that adds missing file-first entries", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 3,
      activeSourceFileCount: 3,
      activeGeneratedObjectCount: 49,
      candidateGeneratedObjectCount: 47,
      candidateOnlyObjectCount: 47,
      activeGeneratedEntryCount: 41,
      candidateGeneratedEntryCount: 53,
      maintenanceRebuild: true
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 482,
      maximumCandidateOnlyObjects: 482,
      candidateCompletenessAllowanceUsed: true
    });
  });

  it("keeps the candidate-only ratio for ordinary or unchanged maintenance work", () => {
    const measured = {
      sourceFileCount: 3,
      activeSourceFileCount: 3,
      activeGeneratedObjectCount: 49,
      candidateGeneratedObjectCount: 47,
      candidateOnlyObjectCount: 47,
      activeGeneratedEntryCount: 41,
      candidateGeneratedEntryCount: 53
    };
    expect(evaluateStorageVnextObjectFanoutBudget(measured)).toMatchObject({
      passed: false,
      candidateRatioPassed: false,
      candidateCompletenessAllowanceUsed: false
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      ...measured,
      activeGeneratedEntryCount: 53,
      maintenanceRebuild: true
    })).toMatchObject({
      passed: false,
      candidateRatioPassed: false,
      candidateCompletenessAllowanceUsed: false
    });
  });

  it("keeps the absolute fan-out ceiling during completeness maintenance", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 3,
      activeSourceFileCount: 3,
      activeGeneratedObjectCount: 49,
      candidateGeneratedObjectCount: 483,
      candidateOnlyObjectCount: 483,
      activeGeneratedEntryCount: 41,
      candidateGeneratedEntryCount: 53,
      maintenanceRebuild: true
    })).toMatchObject({
      passed: false,
      activeFanoutPassed: false
    });
  });

  it("adds fixed projection shards to the per-source object ceiling", () => {
    const complete = evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 53,
      activeSourceFileCount: 0,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 538,
      candidateOnlyObjectCount: 538,
      candidateGeneratedEntryCount: 506
    });
    expect(complete).toMatchObject({
      maximumActiveObjects: 732,
      activeFanoutPassed: true,
      passed: true
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      ...complete,
      candidateGeneratedObjectCount: 733,
      candidateOnlyObjectCount: 733
    })).toMatchObject({
      activeFanoutPassed: false,
      passed: false
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
