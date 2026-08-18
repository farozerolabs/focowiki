import { createHash } from "node:crypto";
import {
  DOCUMENT_WORK_KINDS,
  type DocumentWorkKind
} from "./document-work-graph.js";

export type DocumentFixedWorkContract = {
  sourceChecksumSha256: string;
  runtimeSettingsRevisionPublicId: string;
  generationModelConfigurationPublicId: string | null;
  generationModelConfigurationRevision: number | null;
  embeddingConfigurationRevisionPublicId: string | null;
  semanticContractVersion: string;
};

export function documentFixedWorkPublicId(
  documentJobPublicId: string,
  workKind: DocumentWorkKind
): string {
  return `document-work-${createHash("sha256")
    .update(JSON.stringify([documentJobPublicId, workKind]))
    .digest("hex")}`;
}

export function documentFixedWorkInputFingerprint(
  workKind: DocumentWorkKind,
  contract: DocumentFixedWorkContract
): string {
  return createHash("sha256").update(JSON.stringify([
    "fixed-document-work-v1",
    workKind,
    contract.sourceChecksumSha256,
    contract.runtimeSettingsRevisionPublicId,
    contract.generationModelConfigurationPublicId,
    contract.generationModelConfigurationRevision,
    contract.embeddingConfigurationRevisionPublicId,
    contract.semanticContractVersion
  ])).digest("hex");
}

export function documentFixedWorkInputFingerprints(
  contract: DocumentFixedWorkContract
): Record<DocumentWorkKind, string> {
  return Object.fromEntries(DOCUMENT_WORK_KINDS.map((kind) => [
    kind,
    documentFixedWorkInputFingerprint(kind, contract)
  ])) as Record<DocumentWorkKind, string>;
}
