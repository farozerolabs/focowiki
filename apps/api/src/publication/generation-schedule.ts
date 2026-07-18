import type { SerializableJson } from "../application/ports/source-dispatch-repository.js";
import { readPublicationScheduleSettings } from "./publication-settings-snapshot.js";

export type GenerationSchedule = {
  enqueue: boolean;
  runAfter: string | null;
};

export function resolveGenerationSchedule(input: {
  settingsSnapshot: SerializableJson;
  generationCreatedAt: string;
  completedAt: string;
  changeCount: number;
}): GenerationSchedule {
  const publication = readPublicationScheduleSettings(input.settingsSnapshot);
  if (publication.mode === "manual") {
    return { enqueue: false, runAfter: null };
  }
  if (publication.mode === "per_file" || input.changeCount >= publication.batchSize) {
    return { enqueue: true, runAfter: input.completedAt };
  }
  return {
    enqueue: true,
    runAfter: new Date(
      Date.parse(input.generationCreatedAt) + publication.intervalSeconds * 1_000
    ).toISOString()
  };
}
