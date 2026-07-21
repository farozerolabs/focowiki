export type GenerationAssemblyDispatchRepository = {
  dispatchPending: (input: {
    now: string;
    limit: number;
  }) => Promise<number>;
};
