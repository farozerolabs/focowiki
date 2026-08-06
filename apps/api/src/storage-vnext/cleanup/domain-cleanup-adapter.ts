import type {
  StorageVnextBoundedMetadata
} from "../shared/types.js";
import type {
  StorageVnextCleanupPlane,
  StorageVnextCleanupTarget,
  StorageVnextTerminalCleanupAdapter,
  StorageVnextTerminalContext
} from "./terminal-convergence.js";

export type StorageVnextDomainCleanupResult = {
  status: "completed" | "blocked" | "retry";
  reasonCode: string | null;
  checkpoint: StorageVnextBoundedMetadata;
};

export type StorageVnextDomainCleanupHandler<ResourceKind extends string> = (
  input: {
    context: StorageVnextTerminalContext;
    target: StorageVnextCleanupTarget<ResourceKind>;
  }
) => Promise<StorageVnextDomainCleanupResult>;

export type StorageVnextDomainCleanupResource<ResourceKind extends string> = {
  resourceKind: ResourceKind;
  plane: StorageVnextCleanupPlane;
  required?: boolean;
};

export function createStorageVnextDomainCleanupAdapter<
  Domain extends string,
  ResourceKind extends string
>(input: {
  domain: Domain;
  resources: readonly StorageVnextDomainCleanupResource<ResourceKind>[];
  clean: StorageVnextDomainCleanupHandler<ResourceKind>;
}): StorageVnextTerminalCleanupAdapter<Domain, ResourceKind> {
  return {
    domain: input.domain,
    async plan(context) {
      return input.resources.map((resource, index) => ({
        publicId: context.workPublicId,
        resourceKind: resource.resourceKind,
        plane: resource.plane,
        required: resource.required ?? true,
        sequence: (index + 1) * 10
      }));
    },
    async clean({ context, target }) {
      const result = await input.clean({ context, target });
      return { target, ...result };
    }
  };
}
