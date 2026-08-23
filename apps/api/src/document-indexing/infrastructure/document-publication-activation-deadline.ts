import type { DatabaseClient } from "../../db/client.js";

export const DOCUMENT_PUBLICATION_ACTIVATION_TIMEOUT_MS = 30 * 60 * 1_000;

export function createActivationDeadlineSql(
  sql: DatabaseClient,
  timeoutMilliseconds: number
): { sql: DatabaseClient; dispose: () => void } {
  const deadlineAt = Date.now() + timeoutMilliseconds;
  let expired = false;
  let activeQuery: { cancel(): void } | null = null;
  const timer = setTimeout(() => {
    expired = true;
    activeQuery?.cancel();
  }, timeoutMilliseconds);
  timer.unref?.();
  const wrapped = new Proxy(sql as unknown as Function, {
    apply(target, thisArgument, argumentsList) {
      const firstArgument = argumentsList[0];
      const taggedTemplate = Array.isArray(firstArgument)
        && "raw" in firstArgument;
      if (!taggedTemplate) {
        return Reflect.apply(target, thisArgument, argumentsList);
      }
      if (expired || Date.now() >= deadlineAt) {
        expired = true;
        throw deadlineError();
      }
      const query = Reflect.apply(target, thisArgument, argumentsList) as
        PromiseLike<unknown> & { cancel?: () => void };
      activeQuery = typeof query.cancel === "function"
        ? { cancel: () => query.cancel?.() } : null;
      return Promise.resolve(query).then(
        (result) => {
          activeQuery = null;
          return result;
        },
        (error) => {
          activeQuery = null;
          if (expired || Date.now() >= deadlineAt) {
            throw deadlineError(error);
          }
          throw error;
        }
      );
    },
    get(target, property) {
      return Reflect.get(target, property, target);
    }
  }) as unknown as DatabaseClient;
  return {
    sql: wrapped,
    dispose() {
      clearTimeout(timer);
      activeQuery = null;
    }
  };
}

export function isActivationDeadlineError(input: Readonly<{
  error: unknown;
  elapsedMilliseconds: number;
  timeoutMilliseconds: number;
}>): boolean {
  const code = errorCode(input.error);
  if (code === "publication_activation_deadline_exceeded") return true;
  if (code === "25P04") return true;
  if (code === "CONNECTION_CLOSED") {
    const tolerance = Math.min(
      1_000,
      Math.max(10, Math.floor(input.timeoutMilliseconds * 0.05))
    );
    return input.elapsedMilliseconds
      >= input.timeoutMilliseconds - tolerance;
  }
  if (code !== "57014") return false;
  const message = input.error instanceof Error
    ? input.error.message.toLowerCase() : "";
  return message.includes("statement timeout")
    || message.includes("transaction timeout");
}

function deadlineError(cause?: unknown): Error & { code: string } {
  return Object.assign(
    new Error(
      "Document publication activation error: publication_activation_deadline_exceeded",
      cause === undefined ? undefined : { cause }
    ),
    { code: "publication_activation_deadline_exceeded" }
  );
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : "unknown";
}
