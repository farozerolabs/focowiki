import type { StorageVnextTerminalOutcome } from "./terminal-convergence.js";

export type StorageVnextExitSignal =
  | { type: "completed"; resultCode: string }
  | { type: "failed"; resultCode: string }
  | { type: "cancelled"; resultCode: string }
  | { type: "superseded"; resultCode: string }
  | { type: "timed_out"; resultCode: string }
  | { type: "retry_exhausted"; resultCode: string }
  | { type: "restarted"; resultCode: string }
  | { type: "conflicted"; resultCode: string }
  | { type: "knowledge_base_deleted"; resultCode: string };

export type StorageVnextExitDecision = {
  transition: "terminal" | "retry";
  outcome: StorageVnextTerminalOutcome | null;
  resultCode: string;
  cleanup: "terminal" | "attempt";
  releaseLease: true;
};

export function decideStorageVnextExit(input: {
  workState: "queued" | "running" | "retry";
  exit: StorageVnextExitSignal;
}): StorageVnextExitDecision {
  assertLiveState(input.workState);
  assertResultCode(input.exit.resultCode);

  if (input.exit.type === "restarted") {
    return {
      transition: "retry",
      outcome: null,
      resultCode: input.exit.resultCode,
      cleanup: "attempt",
      releaseLease: true
    };
  }

  return {
    transition: "terminal",
    outcome: terminalOutcome(input.exit.type),
    resultCode: input.exit.resultCode,
    cleanup: "terminal",
    releaseLease: true
  };
}

function terminalOutcome(
  type: Exclude<StorageVnextExitSignal["type"], "restarted">
): StorageVnextTerminalOutcome {
  switch (type) {
    case "completed":
    case "failed":
    case "cancelled":
    case "superseded":
    case "timed_out":
      return type;
    case "retry_exhausted":
    case "conflicted":
      return "failed";
    case "knowledge_base_deleted":
      return "deleted";
  }
}

function assertLiveState(state: string): void {
  if (state !== "queued" && state !== "running" && state !== "retry") {
    throw new Error("Storage vNext exit requires live work");
  }
}

function assertResultCode(resultCode: string): void {
  if (resultCode.length === 0 || Buffer.byteLength(resultCode, "utf8") > 128) {
    throw new Error("Storage vNext exit result code is invalid");
  }
}
