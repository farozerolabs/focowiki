import type { StorageVnextCatalogReadPort } from "../catalog/ports.js";
import type { DatabaseClient } from "../../db/client.js";
import {
  deriveStorageVnextReleaseDependencyClosure,
  includeStorageVnextNavigationProfileUpgrade
} from
  "../release/dependency-closure.js";
import type {
  StorageVnextCandidateDependency,
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort
} from "../release/ports.js";
import {
  createStorageVnextMaintenanceCandidatePublicId,
  createStorageVnextMaintenanceRootPublicId
} from "./identity.js";

type PlannerCatalog = Pick<
  StorageVnextCatalogReadPort,
  "getKnowledgeBase" | "listCurrentSources" | "listDirectories"
>;

type PlannerReleases = Pick<
  StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
  "getActiveRoot" | "getLiveCandidate" | "createCandidate" | "addCandidateFacts"
>;

type OperationIdentity = {
  idempotencyKey: string;
  requestHash: string;
};

export function createPostgresStorageVnextMaintenanceOperationIdentity(
  sql: DatabaseClient
) {
  return {
    async read(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
    }): Promise<OperationIdentity | null> {
      const rows = await sql<Array<{
        idempotency_key: string;
        request_hash: string;
      }>>`
        SELECT idempotency_key, request_hash
        FROM focowiki.operation_idempotency
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND operation_public_id = ${input.operationPublicId}
          AND expires_at > now()
        LIMIT 1
      `;
      const row = rows[0];
      return row ? {
        idempotencyKey: row.idempotency_key,
        requestHash: row.request_hash
      } : null;
    }
  };
}

export function createStorageVnextMaintenanceProductionPlanner(input: {
  catalog: PlannerCatalog;
  releases: PlannerReleases;
  operationIdentity: {
    read(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
    }): Promise<OperationIdentity | null>;
  };
  sourcePageSize: number;
  directoryPageSize: number;
  writeBatchSize: number;
}) {
  assertPageSize(input.sourcePageSize);
  assertPageSize(input.directoryPageSize);
  assertPageSize(input.writeBatchSize);
  return {
    async plan(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      expectedResourceRevision: number;
      createdAt: string;
    }) {
      validateRequest(request);
      const knowledgeBase = await input.catalog.getKnowledgeBase({
        knowledgeBaseId: request.knowledgeBaseId
      });
      if (!knowledgeBase || knowledgeBase.visibility !== "current") {
        throw planningError("knowledge_base_deleted");
      }
      if (knowledgeBase.revision !== request.expectedResourceRevision) {
        throw planningError("stale_plan");
      }

      const candidatePublicId = createStorageVnextMaintenanceCandidatePublicId(request);
      const candidateRootPublicId = createStorageVnextMaintenanceRootPublicId(request);
      const active = await input.releases.getActiveRoot(request.knowledgeBaseId);
      const live = await input.releases.getLiveCandidate(request.knowledgeBaseId);
      if (live && (
        live.publicId !== candidatePublicId
        || live.operationPublicId !== request.operationPublicId
        || live.expectedActiveRootPublicId !== (active?.publicId ?? null)
        || live.expectedActiveRevision !== (active?.revision ?? 0)
      )) throw planningError("stale_plan");

      if (!live) {
        const operationIdentity = await input.operationIdentity.read({
          knowledgeBaseId: request.knowledgeBaseId,
          operationPublicId: request.operationPublicId
        });
        if (!operationIdentity) throw planningError("operation_identity_missing");
        const required = includeStorageVnextNavigationProfileUpgrade({
          knowledgeBaseId: request.knowledgeBaseId,
          navigationProfileVersion: active?.navigationProfileVersion ?? null,
          dependencies: dependencyClosure(request.knowledgeBaseId, {
          sourceFilePublicIds: [],
          sourceLogicalPaths: [],
          directoryLogicalPaths: []
          })
        });
        try {
          await input.releases.createCandidate({
            publicId: candidatePublicId,
            knowledgeBaseId: request.knowledgeBaseId,
            operationPublicId: request.operationPublicId,
            candidateRootPublicId,
            expectedActiveRootPublicId: active?.publicId ?? null,
            expectedActiveRevision: active?.revision ?? 0,
            changedFacts: [{
              kind: "knowledge_base",
              publicId: request.knowledgeBaseId,
              change: "updated"
            }],
            dependencies: required,
            idempotency: {
              key: operationIdentity.idempotencyKey,
              requestHash: operationIdentity.requestHash
            },
            createdAt: request.createdAt
          });
        } catch (error) {
          if (hasCode(error, "live_candidate_exists")) {
            throw planningError("stale_plan");
          }
          throw error;
        }
      }

      let sourceCount = 0;
      let sourceCursor: string | null = null;
      do {
        const page = await input.catalog.listCurrentSources({
          knowledgeBaseId: request.knowledgeBaseId,
          limit: input.sourcePageSize,
          cursor: sourceCursor
        });
        assertPage(page.items.length, input.sourcePageSize);
        const dependencies = dependencyClosure(request.knowledgeBaseId, {
          sourceFilePublicIds: page.items.map((item) => item.sourceFile.publicId),
          sourceLogicalPaths: page.items.map((item) => item.sourceFile.logicalPath),
          directoryLogicalPaths: []
        });
        await addDependencies(input, candidatePublicId, dependencies);
        sourceCount += page.items.length;
        sourceCursor = advancingCursor(sourceCursor, page.nextCursor, "source");
      } while (sourceCursor !== null);

      let directoryCount = 0;
      let directoryCursor: string | null = null;
      do {
        const page = await input.catalog.listDirectories({
          knowledgeBaseId: request.knowledgeBaseId,
          parentPublicId: undefined,
          limit: input.directoryPageSize,
          cursor: directoryCursor
        });
        assertPage(page.items.length, input.directoryPageSize);
        const dependencies = dependencyClosure(request.knowledgeBaseId, {
          sourceFilePublicIds: [],
          sourceLogicalPaths: [],
          directoryLogicalPaths: page.items.map((item) => item.logicalPath)
        });
        await addDependencies(input, candidatePublicId, dependencies);
        directoryCount += page.items.length;
        directoryCursor = advancingCursor(
          directoryCursor,
          page.nextCursor,
          "directory"
        );
      } while (directoryCursor !== null);

      return { candidatePublicId, candidateRootPublicId, sourceCount, directoryCount };
    }
  };
}

function dependencyClosure(
  knowledgeBaseId: string,
  input: {
    sourceFilePublicIds: readonly string[];
    sourceLogicalPaths: readonly string[];
    directoryLogicalPaths: readonly string[];
  }
): readonly StorageVnextCandidateDependency[] {
  return deriveStorageVnextReleaseDependencyClosure({
    knowledgeBaseId,
    mutationKind: "search_change",
    sourceFilePublicIds: input.sourceFilePublicIds,
    sourceLogicalPaths: input.sourceLogicalPaths,
    previousSourceLogicalPaths: [],
    directoryLogicalPaths: input.directoryLogicalPaths,
    searchSourceFilePublicIds: input.sourceFilePublicIds,
    graphSourceFilePublicIds: input.sourceFilePublicIds,
    graphEdgePublicIds: []
  }).dependencies;
}

async function addDependencies(
  input: Parameters<typeof createStorageVnextMaintenanceProductionPlanner>[0],
  candidatePublicId: string,
  dependencies: readonly StorageVnextCandidateDependency[]
): Promise<void> {
  for (let offset = 0; offset < dependencies.length; offset += input.writeBatchSize) {
    await input.releases.addCandidateFacts({
      candidatePublicId,
      changedFacts: [],
      dependencies: dependencies.slice(offset, offset + input.writeBatchSize)
    });
  }
}

function advancingCursor(
  previous: string | null,
  next: string | null,
  kind: string
): string | null {
  if (next !== null && next === previous) {
    throw planningError(`${kind}_cursor_stalled`);
  }
  return next;
}

function validateRequest(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  expectedResourceRevision: number;
  createdAt: string;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.operationPublicId
    || !Number.isSafeInteger(input.expectedResourceRevision)
    || input.expectedResourceRevision < 0
    || !Number.isFinite(Date.parse(input.createdAt))
  ) throw planningError("invalid_input");
}

function assertPageSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw planningError("invalid_configuration");
  }
}

function assertPage(actual: number, maximum: number): void {
  if (actual > maximum) throw planningError("page_overflow");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function planningError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext maintenance planning error: ${code}`),
    { code }
  );
}
