import { mapWithConcurrency } from "../runtime/bounded.js";

export type LexicalCapacityOutcome = {
  completed: number;
  retried: number;
};

export async function runLexicalCapacityRefill<T>(input: {
  concurrency: number;
  databaseBatchSize: number;
  maxClaimCycles: number;
  claim: () => Promise<T[]>;
  onClaim?: ((claims: T[]) => Promise<void>) | undefined;
  process: (claims: T[]) => Promise<LexicalCapacityOutcome>;
}): Promise<{
  claimCycles: number;
  claimed: number;
  completed: number;
  retried: number;
  drained: boolean;
}> {
  const maxClaimCycles = positiveInteger(input.maxClaimCycles, "max claim cycles");
  let claimCycles = 0;
  let claimed = 0;
  let completed = 0;
  let retried = 0;

  while (claimCycles < maxClaimCycles) {
    claimCycles += 1;
    const claims = await input.claim();
    if (claims.length === 0) {
      return { claimCycles, claimed, completed, retried, drained: true };
    }
    claimed += claims.length;
    await input.onClaim?.(claims);
    const outcomes = await mapWithConcurrency(
      chunk(claims, input.databaseBatchSize),
      input.concurrency,
      input.process
    );
    completed += outcomes.reduce((sum, outcome) => sum + outcome.completed, 0);
    retried += outcomes.reduce((sum, outcome) => sum + outcome.retried, 0);
  }

  return { claimCycles, claimed, completed, retried, drained: false };
}

function chunk<T>(values: T[], size: number): T[][] {
  const boundedSize = positiveInteger(size, "database batch size");
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += boundedSize) {
    result.push(values.slice(offset, offset + boundedSize));
  }
  return result;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}
