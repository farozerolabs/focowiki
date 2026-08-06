import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as convergenceModule from "../src/storage-vnext/cleanup/terminal-convergence.js";
import type {
  StorageVnextCleanupReceipt,
  StorageVnextCleanupTarget,
  StorageVnextTerminalCleanupAdapter,
  StorageVnextTerminalContext,
  StorageVnextTerminalConvergencePort
} from "../src/storage-vnext/cleanup/terminal-convergence.js";

type ConvergenceFactory = (input: {
  adapters: readonly StorageVnextTerminalCleanupAdapter<string>[];
  maximumTargets: number;
}) => StorageVnextTerminalConvergencePort;

const context: StorageVnextTerminalContext = {
  workPublicId: "operation-terminal-runtime",
  knowledgeBaseId: "knowledge-base-terminal-runtime",
  operationRevision: 7,
  outcome: "failed",
  resultCode: "SOURCE_FAILED",
  safeMessage: "Source processing failed.",
  checkpoint: { stage: "model" },
  completedAt: "2026-08-01T00:00:00.000Z"
};

function createConvergence(input: {
  adapters: readonly StorageVnextTerminalCleanupAdapter<string>[];
  maximumTargets?: number;
}) {
  const factory = (convergenceModule as unknown as {
    createStorageVnextTerminalConvergence?: ConvergenceFactory;
  }).createStorageVnextTerminalConvergence;
  expect(factory).toBeTypeOf("function");
  return factory?.({
    adapters: input.adapters,
    maximumTargets: input.maximumTargets ?? 16
  }) ?? null;
}

function target(input: {
  publicId: string;
  resourceKind: string;
  plane: "postgres" | "object_storage" | "search" | "redis" | "process";
  required?: boolean;
  sequence: number;
}): StorageVnextCleanupTarget {
  return {
    publicId: input.publicId,
    resourceKind: input.resourceKind,
    plane: input.plane,
    required: input.required ?? true,
    sequence: input.sequence
  };
}

function adapter(input: {
  domain: string;
  targets: readonly StorageVnextCleanupTarget[];
  clean: (target: StorageVnextCleanupTarget) => StorageVnextCleanupReceipt["status"];
  calls: string[];
}): StorageVnextTerminalCleanupAdapter<string> {
  return {
    domain: input.domain,
    async plan() {
      return input.targets;
    },
    async clean({ target: current }) {
      input.calls.push(`${input.domain}:${current.resourceKind}`);
      return {
        target: current,
        status: input.clean(current),
        reasonCode: null,
        checkpoint: {}
      };
    }
  };
}

describe("storage vNext terminal convergence runtime", () => {
  it("executes cross-plane cleanup in one stable global sequence", async () => {
    const calls: string[] = [];
    const convergence = createConvergence({
      adapters: [
        adapter({
          domain: "provider",
          targets: [target({
            publicId: "search-candidate",
            resourceKind: "unified_search_candidate",
            plane: "search",
            sequence: 30
          })],
          clean: () => "completed",
          calls
        }),
        adapter({
          domain: "attempt",
          targets: [
            target({
              publicId: "process-resource",
              resourceKind: "process_resource",
              plane: "process",
              sequence: 10
            }),
            target({
              publicId: "coordination",
              resourceKind: "coordination",
              plane: "redis",
              sequence: 20
            })
          ],
          clean: () => "completed",
          calls
        })
      ]
    });

    const result = await convergence?.converge(context);
    expect(result?.status).toBe("completed");
    expect(calls).toEqual([
      "attempt:process_resource",
      "attempt:coordination",
      "provider:unified_search_candidate"
    ]);
    expect(result?.receipts).toHaveLength(3);
  });

  it("stops after a retry receipt and preserves the later cleanup plan", async () => {
    const calls: string[] = [];
    const convergence = createConvergence({
      adapters: [adapter({
        domain: "publication",
        targets: [
          target({
            publicId: "candidate-task",
            resourceKind: "unified_search_task",
            plane: "search",
            sequence: 10
          }),
          target({
            publicId: "candidate-owner",
            resourceKind: "temporary_owner",
            plane: "postgres",
            sequence: 20
          })
        ],
        clean: (current) => current.resourceKind === "unified_search_task"
          ? "retry"
          : "completed",
        calls
      })]
    });

    const result = await convergence?.converge(context);
    expect(result?.status).toBe("retry");
    expect(calls).toEqual(["publication:unified_search_task"]);
    expect(result?.receipts).toHaveLength(1);
  });

  it("blocks on a required cleanup receipt without touching successors", async () => {
    const calls: string[] = [];
    const convergence = createConvergence({
      adapters: [adapter({
        domain: "mutation",
        targets: [
          target({
            publicId: "path-reservation",
            resourceKind: "reservation",
            plane: "postgres",
            sequence: 10
          }),
          target({
            publicId: "successor-owner",
            resourceKind: "successor_owner",
            plane: "postgres",
            sequence: 20
          })
        ],
        clean: (current) => current.resourceKind === "reservation"
          ? "blocked"
          : "completed",
        calls
      })]
    });

    const result = await convergence?.converge(context);
    expect(result?.status).toBe("blocked");
    expect(calls).toEqual(["mutation:reservation"]);
  });

  it("rejects duplicate cleanup identities before executing a destructive action", async () => {
    const calls: string[] = [];
    const duplicate = target({
      publicId: "candidate-owner",
      resourceKind: "temporary_owner",
      plane: "postgres",
      sequence: 10
    });
    const convergence = createConvergence({
      adapters: [adapter({
        domain: "publication",
        targets: [duplicate, duplicate],
        clean: () => "completed",
        calls
      })]
    });

    await expect(convergence?.converge(context)).rejects.toThrow(
      "Storage vNext cleanup target is duplicated"
    );
    expect(calls).toEqual([]);
  });
});

describe("storage vNext domain cleanup adapters", () => {
  it("exports small adapters covering PostgreSQL, object, search, Redis, and process cleanup", async () => {
    const adapters = [
      ["upload", "createStorageVnextUploadCleanupAdapter"],
      ["source-processing", "createStorageVnextSourceProcessingCleanupAdapter"],
      ["publication", "createStorageVnextPublicationCleanupAdapter"],
      ["mutation", "createStorageVnextMutationCleanupAdapter"],
      ["hard-delete", "createStorageVnextHardDeleteCleanupAdapter"],
      ["search-rebuild", "createStorageVnextSearchRebuildCleanupAdapter"],
      ["projection-repair", "createStorageVnextProjectionRepairCleanupAdapter"],
      ["reconciliation", "createStorageVnextReconciliationCleanupAdapter"],
      ["webhook", "createStorageVnextWebhookCleanupAdapter"],
      ["security", "createStorageVnextSecurityCleanupAdapter"]
    ] as const;
    const planes = new Set<string>();
    const resourceKinds = new Set<string>();

    for (const [file, factoryName] of adapters) {
      const modulePath = resolve(
        import.meta.dirname,
        `../src/storage-vnext/cleanup/adapters/${file}.ts`
      );
      const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as Record<
        string,
        ((input: { clean: (input: unknown) => Promise<unknown> }) => {
          plan(context: StorageVnextTerminalContext): Promise<readonly StorageVnextCleanupTarget[]>;
        }) | undefined
      >;
      const factory = loaded[factoryName];
      expect(factory, factoryName).toBeTypeOf("function");
      if (!factory) continue;
      const planned = await factory({
        clean: async () => ({ status: "completed", reasonCode: null, checkpoint: {} })
      }).plan(context);
      for (const item of planned) {
        planes.add(item.plane);
        resourceKinds.add(item.resourceKind);
      }
    }

    expect(planes).toEqual(new Set([
      "postgres",
      "object_storage",
      "search",
      "redis",
      "process"
    ]));
    expect([...resourceKinds]).toEqual(expect.arrayContaining([
      "process_resource",
      "coordination",
      "reservation",
      "temporary_object",
      "temporary_owner",
      "unified_search_candidate",
      "unified_search_task",
      "source_checkpoint",
      "scan_checkpoint",
      "delivery_attempt"
    ]));
  });
});
