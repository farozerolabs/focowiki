import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type ExitSignal =
  | { type: "completed"; resultCode: string }
  | { type: "failed"; resultCode: string }
  | { type: "cancelled"; resultCode: string }
  | { type: "superseded"; resultCode: string }
  | { type: "timed_out"; resultCode: string }
  | { type: "retry_exhausted"; resultCode: string }
  | { type: "restarted"; resultCode: string }
  | { type: "conflicted"; resultCode: string }
  | { type: "knowledge_base_deleted"; resultCode: string };

type ExitDecision = {
  transition: "terminal" | "retry";
  outcome:
    | "completed"
    | "failed"
    | "cancelled"
    | "superseded"
    | "timed_out"
    | "deleted"
    | null;
  resultCode: string;
  cleanup: "terminal" | "attempt";
  releaseLease: true;
};

type StateMachineModule = {
  decideStorageVnextExit(input: {
    workState: "queued" | "running" | "retry";
    exit: ExitSignal;
  }): ExitDecision;
};

const modulePath = resolve(
  import.meta.dirname,
  "../src/storage-vnext/cleanup/terminal-state-machine.ts"
);

async function loadStateMachine(): Promise<StateMachineModule | null> {
  expect(existsSync(modulePath), modulePath).toBe(true);
  if (!existsSync(modulePath)) return null;
  return import(/* @vite-ignore */ pathToFileURL(modulePath).href) as Promise<StateMachineModule>;
}

async function decide(exit: ExitSignal): Promise<ExitDecision | null> {
  const stateMachine = await loadStateMachine();
  return stateMachine?.decideStorageVnextExit({
    workState: "running",
    exit
  }) ?? null;
}

describe("storage vNext terminal state machine", () => {
  it("transfers completed work to one terminal result and terminal cleanup", async () => {
    await expect(decide({ type: "completed", resultCode: "COMPLETED" })).resolves.toEqual({
      transition: "terminal",
      outcome: "completed",
      resultCode: "COMPLETED",
      cleanup: "terminal",
      releaseLease: true
    });
  });

  it("transfers an unrecoverable failure to one failed result", async () => {
    await expect(decide({ type: "failed", resultCode: "SOURCE_FAILED" })).resolves.toEqual({
      transition: "terminal",
      outcome: "failed",
      resultCode: "SOURCE_FAILED",
      cleanup: "terminal",
      releaseLease: true
    });
  });

  it("stops cancelled work and requires terminal cleanup", async () => {
    await expect(decide({ type: "cancelled", resultCode: "CANCELLED" })).resolves.toEqual({
      transition: "terminal",
      outcome: "cancelled",
      resultCode: "CANCELLED",
      cleanup: "terminal",
      releaseLease: true
    });
  });

  it("stops superseded work without touching the successor", async () => {
    await expect(decide({ type: "superseded", resultCode: "SUPERSEDED" })).resolves.toEqual({
      transition: "terminal",
      outcome: "superseded",
      resultCode: "SUPERSEDED",
      cleanup: "terminal",
      releaseLease: true
    });
  });

  it("makes an expired operation terminal without resetting its deadline", async () => {
    await expect(decide({ type: "timed_out", resultCode: "TIMED_OUT" })).resolves.toEqual({
      transition: "terminal",
      outcome: "timed_out",
      resultCode: "TIMED_OUT",
      cleanup: "terminal",
      releaseLease: true
    });
  });

  it("maps retry exhaustion to the released-compatible failed state", async () => {
    await expect(decide({
      type: "retry_exhausted",
      resultCode: "RETRY_EXHAUSTED"
    })).resolves.toEqual({
      transition: "terminal",
      outcome: "failed",
      resultCode: "RETRY_EXHAUSTED",
      cleanup: "terminal",
      releaseLease: true
    });
  });

  it("keeps restarted work live and releases only attempt resources", async () => {
    await expect(decide({ type: "restarted", resultCode: "WORKER_RESTARTED" })).resolves.toEqual({
      transition: "retry",
      outcome: null,
      resultCode: "WORKER_RESTARTED",
      cleanup: "attempt",
      releaseLease: true
    });
  });

  it("maps an accepted-operation conflict to a bounded failed result", async () => {
    await expect(decide({ type: "conflicted", resultCode: "REVISION_CONFLICT" })).resolves.toEqual({
      transition: "terminal",
      outcome: "failed",
      resultCode: "REVISION_CONFLICT",
      cleanup: "terminal",
      releaseLease: true
    });
  });

  it("makes knowledge-base deletion the terminal scope owner", async () => {
    await expect(decide({
      type: "knowledge_base_deleted",
      resultCode: "KNOWLEDGE_BASE_DELETED"
    })).resolves.toEqual({
      transition: "terminal",
      outcome: "deleted",
      resultCode: "KNOWLEDGE_BASE_DELETED",
      cleanup: "terminal",
      releaseLease: true
    });
  });
});
