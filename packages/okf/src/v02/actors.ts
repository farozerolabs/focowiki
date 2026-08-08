export type OkfActorKind = "human" | "process" | "agent" | "unknown";

export function classifyOkfActor(value: unknown): OkfActorKind | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/^human:[^\s:][^\s]*$/u.test(value)) return "human";
  if (/^process:[^\s:][^\s]*$/u.test(value)) return "process";
  if (/^[^\s/]+\/[^\s/]+$/u.test(value)) return "agent";
  return "unknown";
}

export function isHumanOkfActor(value: unknown): boolean {
  return classifyOkfActor(value) === "human";
}
