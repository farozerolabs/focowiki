import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIModelClient } from "@focowiki/okf";
import {
  createDirectoryLeafId,
  createPacedModelClient
} from
  "../src/document-indexing/infrastructure/production-document-processor-support.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("production generation model client", () => {
  it("keeps zero-interval in-flight concurrency work-conserving", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const paced = createPacedModelClient({
      apiMode: "responses",
      responses: {
        create: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          return { status: "completed" };
        }
      }
    }, { concurrency: 2, minStartIntervalMs: 0 });
    if (paced.apiMode === "chat_completions") throw new Error("unexpected mode");

    const requests = [
      paced.responses.create({} as never),
      paced.responses.create({} as never)
    ];
    await vi.waitFor(() => expect(maximumActive).toBe(2));
    releases.forEach((release) => release());
    await Promise.all(requests);
  });

  it("does not share positive start intervals across revision clients", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const starts: number[] = [];
    const createClient = () => createPacedModelClient({
      apiMode: "responses" as const,
      responses: { create: async () => {
        starts.push(Date.now());
        return { status: "completed" };
      } }
    }, { concurrency: 1, minStartIntervalMs: 100 });
    const first = createClient();
    const second = createClient();
    if (first.apiMode === "chat_completions"
      || second.apiMode === "chat_completions") throw new Error("unexpected mode");

    await Promise.all([
      first.responses.create({} as never),
      second.responses.create({} as never)
    ]);
    expect(starts).toEqual([1_000, 1_000]);
  });

  it("applies the configured minimum interval to every provider request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const starts: number[] = [];
    const client: OpenAIModelClient = {
      apiMode: "responses",
      responses: {
        create: async () => {
          starts.push(Date.now());
          return { status: "completed" };
        }
      }
    };
    const paced = createPacedModelClient(client, {
      concurrency: 2,
      minStartIntervalMs: 100
    });
    if (paced.apiMode === "chat_completions") throw new Error("unexpected mode");

    const first = paced.responses.create({} as never);
    const second = paced.responses.create({} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([1_000]);
    await vi.advanceTimersByTimeAsync(99);
    expect(starts).toEqual([1_000]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(starts).toEqual([1_000, 1_100]);
  });

  it("preserves chat-completions request routing", async () => {
    const create = vi.fn(async () => ({ choices: [] }));
    const paced = createPacedModelClient({
      apiMode: "chat_completions",
      chat: { completions: { create } }
    }, { concurrency: 1, minStartIntervalMs: 0 });
    if (paced.apiMode !== "chat_completions") throw new Error("unexpected mode");
    await paced.chat.completions.create({} as never);
    expect(create).toHaveBeenCalledOnce();
  });

  it.each(["responses", "chat_completions"] as const)(
    "forwards %s request options through the pacing boundary",
    async (apiMode) => {
      const create = vi.fn(async () => ({ status: "completed" }));
      const client = apiMode === "responses"
        ? { apiMode, responses: { create } }
        : { apiMode, chat: { completions: { create } } };
      const paced = createPacedModelClient(
        client as OpenAIModelClient,
        { concurrency: 1, minStartIntervalMs: 0 }
      );
      const controller = new AbortController();
      if (paced.apiMode === "chat_completions") {
        await paced.chat.completions.create({} as never, {
          signal: controller.signal
        });
      } else {
        await paced.responses.create({} as never, {
          signal: controller.signal
        });
      }

      expect(create).toHaveBeenCalledWith(
        expect.anything(),
        { signal: controller.signal }
      );
    }
  );
});

describe("directory leaf identity", () => {
  it("stays stable across concurrent projection revisions", () => {
    const create = () => createDirectoryLeafId({
      prefix: "extension-leaf",
      knowledgeBaseId: "knowledge-base-1",
      directoryPath: "_graph/by-directory",
      occupiedLeafIds: new Set(),
      sequence: 1
    });

    expect(create()).toBe(create());
  });
});
