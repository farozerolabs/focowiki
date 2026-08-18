import type {
  DocumentKnowledgeProjectionManifest
} from "./document-knowledge-projection-manifest.js";

type ActivationOwner = DocumentKnowledgeProjectionManifest["activationOwners"][number];

export function rebaseDocumentActivationOwnerVersions(input: {
  desired: readonly ActivationOwner[];
  current: readonly {
    kind: ActivationOwner["kind"];
    key: string;
    version: number;
  }[];
}): ActivationOwner[] {
  const currentByIdentity = new Map(input.current.map((owner) => [
    identity(owner), owner.version
  ]));
  return input.desired.map((owner) => {
    const version = currentByIdentity.get(identity(owner));
    if (version === undefined) {
      throw activationRebaseError("activation_owner_snapshot_incomplete");
    }
    return { ...owner, expectedVersion: version };
  });
}

function identity(owner: { kind: string; key: string }): string {
  return `${owner.kind}\0${owner.key}`;
}

function activationRebaseError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document activation rebase error: ${code}`), {
    code
  });
}
