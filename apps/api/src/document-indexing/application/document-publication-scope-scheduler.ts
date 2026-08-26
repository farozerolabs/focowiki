export type DocumentPublicationScheduledNode = Readonly<{
  identity: string;
  dependsOn: readonly string[];
}>;

export async function runDocumentPublicationScopesBounded<Node, Output>(input: {
  nodes: readonly (Node & DocumentPublicationScheduledNode)[];
  maximumConcurrency: number;
  signal: AbortSignal;
  execute(node: Node, signal: AbortSignal): Promise<Output>;
  consume(node: Node, output: Output): void;
}): Promise<Readonly<{ peakActiveCount: number }>> {
  assertConcurrency(input.maximumConcurrency);
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const identities = new Set(input.nodes.map((node) => node.identity));
  const pending = new Map(input.nodes.map((node) => [node.identity, node]));
  const completed = new Set<string>();
  const active = new Map<string, Promise<ScopeSettlement<Node, Output>>>();
  let peakActiveCount = 0;

  try {
    while (pending.size > 0 || active.size > 0) {
      signal.throwIfAborted();
      for (const [identity, node] of pending) {
        if (active.size >= input.maximumConcurrency) break;
        const ready = node.dependsOn
          .filter((dependency) => identities.has(dependency))
          .every((dependency) => completed.has(dependency));
        if (!ready) continue;
        pending.delete(identity);
        const execution = input.execute(node, signal).then(
          (output): ScopeSettlement<Node, Output> => ({
            status: "fulfilled", node, output
          }),
          (error): ScopeSettlement<Node, Output> => ({
            status: "rejected", node, error
          })
        );
        active.set(identity, execution);
        peakActiveCount = Math.max(peakActiveCount, active.size);
      }
      if (active.size === 0) {
        throw schedulerError("publication_dependency_missing");
      }
      const settled = await Promise.race(active.values());
      active.delete(settled.node.identity);
      if (settled.status === "rejected") throw settled.error;
      input.consume(settled.node, settled.output);
      completed.add(settled.node.identity);
    }
    return { peakActiveCount };
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(active.values());
    throw error;
  } finally {
    controller.abort();
  }
}

type ScopeSettlement<Node, Output> =
  | Readonly<{ status: "fulfilled"; node: Node & DocumentPublicationScheduledNode;
    output: Output }>
  | Readonly<{ status: "rejected"; node: Node & DocumentPublicationScheduledNode;
    error: unknown }>;

function assertConcurrency(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw schedulerError("publication_builder_concurrency_invalid");
  }
}

function schedulerError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication scope scheduler error: ${code}`), {
    code
  });
}
