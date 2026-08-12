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
    })).toMatchObject({ passed: true, maximumActiveObjects: 971 });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 100,
      activeGeneratedObjectCount: 957,
      candidateGeneratedObjectCount: 972,
      candidateOnlyObjectCount: 10
    })).toMatchObject({ passed: false, activeFanoutPassed: false });
  });

  it("allows the navigation-profile overhead above twenty percent", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 200,
      activeGeneratedObjectCount: 500,
      candidateGeneratedObjectCount: 610,
      candidateOnlyObjectCount: 110
    })).toMatchObject({ passed: true, maximumCandidateOnlyObjects: 110 });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 200,
      activeGeneratedObjectCount: 500,
      candidateGeneratedObjectCount: 611,
      candidateOnlyObjectCount: 111
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
      maximumActiveObjects: 521
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 10,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 522,
      candidateOnlyObjectCount: 522
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
      maximumActiveObjects: 651,
      fileFirstCompletenessAllowanceUsed: true
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 36,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 652,
      candidateOnlyObjectCount: 652
    })).toMatchObject({ passed: false, activeFanoutPassed: false });
  });

  it("allows only the fixed released-navigation overhead for an empty knowledge base", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 0,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 23,
      candidateOnlyObjectCount: 23
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 23,
      maximumCandidateObjects: 23
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 0,
      activeGeneratedObjectCount: 0,
      candidateGeneratedObjectCount: 24,
      candidateOnlyObjectCount: 24
    })).toMatchObject({ passed: false, activeFanoutPassed: false });
  });

  it("validates the active and candidate roots against their own source counts", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 0,
      activeSourceFileCount: 1,
      changedSourceFileCount: 1,
      activeGeneratedObjectCount: 38,
      candidateGeneratedObjectCount: 23,
      candidateOnlyObjectCount: 23
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 476,
      maximumCandidateObjects: 28,
      activeFanoutPassed: true
    });
  });

  it("allows bounded transition objects when deleting the final source", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 0,
      activeSourceFileCount: 1,
      directoryCount: 1,
      activeDirectoryCount: 1,
      changedSourceFileCount: 1,
      activeGeneratedObjectCount: 41,
      candidateGeneratedObjectCount: 24,
      candidateOnlyObjectCount: 11,
      activeGeneratedEntryCount: 31,
      candidateGeneratedEntryCount: 14
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 479,
      maximumCandidateObjects: 31,
      maximumCandidateOnlyObjects: 24,
      activeFanoutPassed: true,
      candidateRatioPassed: true
    });
  });

  it("budgets bounded projection shards while deleting a multi-file tree", () => {
    const measured = {
      sourceFileCount: 0,
      activeSourceFileCount: 53,
      directoryCount: 1,
      activeDirectoryCount: 25,
      changedSourceFileCount: 53,
      changedDirectoryCount: 1,
      activeGeneratedObjectCount: 477,
      candidateGeneratedObjectCount: 43,
      candidateOnlyObjectCount: 15,
      activeGeneratedEntryCount: 445,
      candidateGeneratedEntryCount: 11
    };
    expect(evaluateStorageVnextObjectFanoutBudget(measured)).toMatchObject({
      passed: true,
      maximumActiveObjects: 811,
      maximumCandidateObjects: 294,
      maximumCandidateOnlyObjects: 377,
      activeFanoutPassed: true,
      candidateRatioPassed: true
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      ...measured,
      candidateGeneratedObjectCount: 295
    })).toMatchObject({
      passed: false,
      activeFanoutPassed: false
    });
  });

  it("accepts a previously validated empty transition root during re-upload", () => {
    const measured = {
      sourceFileCount: 53,
      activeSourceFileCount: 0,
      directoryCount: 26,
      activeDirectoryCount: 1,
      changedSourceFileCount: 53,
      changedDirectoryCount: 25,
      activeGeneratedObjectCount: 165,
      candidateGeneratedObjectCount: 536,
      candidateOnlyObjectCount: 371,
      activeGeneratedEntryCount: 13,
      candidateGeneratedEntryCount: 504
    };
    expect(evaluateStorageVnextObjectFanoutBudget(measured)).toMatchObject({
      passed: true,
      maximumActiveObjects: 474,
      maximumCandidateObjects: 814,
      activeFanoutPassed: true,
      candidateRatioPassed: true
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      ...measured,
      activeGeneratedObjectCount: 475
    })).toMatchObject({
      passed: false,
      activeFanoutPassed: false
    });
  });

  it("budgets retained directory navigation after deleting the final source", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 0,
      activeSourceFileCount: 1,
      directoryCount: 26,
      activeDirectoryCount: 26,
      changedSourceFileCount: 1,
      activeGeneratedObjectCount: 113,
      candidateGeneratedObjectCount: 98,
      candidateOnlyObjectCount: 15,
      activeGeneratedEntryCount: 80,
      candidateGeneratedEntryCount: 65
    })).toMatchObject({
      passed: true,
      maximumCandidateObjects: 106,
      activeFanoutPassed: true
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 0,
      activeSourceFileCount: 1,
      directoryCount: 26,
      activeDirectoryCount: 26,
      changedSourceFileCount: 1,
      activeGeneratedObjectCount: 113,
      candidateGeneratedObjectCount: 107,
      candidateOnlyObjectCount: 15,
      activeGeneratedEntryCount: 80,
      candidateGeneratedEntryCount: 65
    })).toMatchObject({
      passed: false,
      activeFanoutPassed: false
    });
  });

  it("budgets the active and candidate directory objects independently", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 0,
      activeSourceFileCount: 0,
      directoryCount: 0,
      activeDirectoryCount: 1,
      activeGeneratedObjectCount: 24,
      candidateGeneratedObjectCount: 23,
      candidateOnlyObjectCount: 11,
      activeGeneratedEntryCount: 14,
      candidateGeneratedEntryCount: 14
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 26,
      maximumCandidateObjects: 23,
      activeFanoutPassed: true,
      candidateRatioPassed: true
    });
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
      maximumActiveObjects: 23,
      maximumCandidateObjects: 511,
      maximumCandidateOnlyObjects: 511
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
      maximumActiveObjects: 516,
      maximumCandidateOnlyObjects: 32
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
      maximumActiveObjects: 516,
      maximumCandidateObjects: 521,
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
      maximumActiveObjects: 966,
      maximumCandidateObjects: 971,
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
      maximumActiveObjects: 516,
      maximumCandidateOnlyObjects: 28
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
      maximumActiveObjects: 516,
      maximumCandidateOnlyObjects: 39,
      candidateChangeAllowanceUsed: true
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 9,
      activeSourceFileCount: 9,
      changedSourceFileCount: 2,
      activeGeneratedObjectCount: 93,
      candidateGeneratedObjectCount: 100,
      candidateOnlyObjectCount: 40
    })).toMatchObject({
      passed: false,
      candidateRatioPassed: false
    });
  });

  it("budgets both old and new navigation objects for a moved directory subtree", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 9,
      activeSourceFileCount: 9,
      directoryCount: 16,
      activeDirectoryCount: 16,
      changedSourceFileCount: 7,
      changedDirectoryCount: 11,
      activeGeneratedObjectCount: 132,
      candidateGeneratedObjectCount: 147,
      candidateOnlyObjectCount: 85,
      activeGeneratedEntryCount: 109,
      candidateGeneratedEntryCount: 112
    })).toMatchObject({
      passed: true,
      maximumCandidateOnlyObjects: 138,
      candidateRatioPassed: true
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 9,
      activeSourceFileCount: 9,
      directoryCount: 16,
      activeDirectoryCount: 16,
      changedSourceFileCount: 7,
      changedDirectoryCount: 11,
      activeGeneratedObjectCount: 132,
      candidateGeneratedObjectCount: 147,
      candidateOnlyObjectCount: 139,
      activeGeneratedEntryCount: 109,
      candidateGeneratedEntryCount: 112
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
      maximumActiveObjects: 486,
      maximumCandidateOnlyObjects: 486,
      candidateCompletenessAllowanceUsed: true
    });
  });

  it("keeps the candidate-only ratio for ordinary publication work", () => {
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
  });

  it("allows a bounded full maintenance rebuild when entry counts are unchanged", () => {
    const measured = {
      sourceFileCount: 53,
      activeSourceFileCount: 53,
      activeGeneratedObjectCount: 547,
      candidateGeneratedObjectCount: 547,
      candidateOnlyObjectCount: 129,
      activeGeneratedEntryCount: 515,
      candidateGeneratedEntryCount: 515,
      maintenanceRebuild: true
    };
    expect(evaluateStorageVnextObjectFanoutBudget({
      ...measured,
    })).toMatchObject({
      passed: true,
      maximumActiveObjects: 736,
      maximumCandidateOnlyObjects: 736,
      candidateRatioPassed: true,
      candidateCompletenessAllowanceUsed: true
    });
  });

  it("keeps the absolute fan-out ceiling during completeness maintenance", () => {
    expect(evaluateStorageVnextObjectFanoutBudget({
      sourceFileCount: 3,
      activeSourceFileCount: 3,
      activeGeneratedObjectCount: 49,
      candidateGeneratedObjectCount: 487,
      candidateOnlyObjectCount: 487,
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
      maximumActiveObjects: 23,
      maximumCandidateObjects: 736,
      activeFanoutPassed: true,
      passed: true
    });
    expect(evaluateStorageVnextObjectFanoutBudget({
      ...complete,
      candidateGeneratedObjectCount: 737,
      candidateOnlyObjectCount: 737
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
