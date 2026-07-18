import type { SerializableJson } from "../application/ports/source-dispatch-repository.js";

export type PublicationScheduleSettings = {
  mode: "batch" | "manual" | "per_file";
  batchSize: number;
  intervalSeconds: number;
};

export type PublicationWorkSettings = {
  impactBatchSize: number;
  impactConcurrency: number;
  directoryIndexMaxEntries: number;
  directoryIndexMaxBytes: number;
};

export function readPublicationScheduleSettings(
  snapshot: SerializableJson
): PublicationScheduleSettings {
  const publication = publicationValue(snapshot);
  const mode = publication.mode;
  if (!["batch", "manual", "per_file"].includes(String(mode))) {
    throw new Error("Publication settings snapshot mode is invalid");
  }
  return {
    mode: mode as PublicationScheduleSettings["mode"],
    batchSize: positiveInteger(publication.batchSize, "batchSize"),
    intervalSeconds: positiveInteger(publication.intervalSeconds, "intervalSeconds")
  };
}

export function readPublicationWorkSettings(
  snapshot: SerializableJson
): PublicationWorkSettings {
  const publication = publicationValue(snapshot);
  return {
    impactBatchSize: positiveInteger(publication.impactBatchSize, "impactBatchSize"),
    impactConcurrency: positiveInteger(
      publication.impactConcurrency,
      "impactConcurrency"
    ),
    directoryIndexMaxEntries: positiveInteger(
      publication.directoryIndexMaxEntries,
      "directoryIndexMaxEntries"
    ),
    directoryIndexMaxBytes: positiveInteger(
      publication.directoryIndexMaxBytes,
      "directoryIndexMaxBytes"
    )
  };
}

function publicationValue(
  snapshot: SerializableJson
): Record<string, SerializableJson | undefined> {
  return objectValue(objectValue(snapshot).publication);
}

function positiveInteger(value: SerializableJson | undefined, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Publication settings snapshot ${field} is invalid`);
  }
  return Number(value);
}

function objectValue(
  value: SerializableJson | undefined
): Record<string, SerializableJson | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    return {};
  }
  return value as Record<string, SerializableJson | undefined>;
}
