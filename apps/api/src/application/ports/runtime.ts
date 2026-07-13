export type ApplicationClock = {
  now: () => Date;
};

export type ApplicationIdGenerator = {
  create: (prefix: string) => string;
};

export type ApplicationRuntime = {
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
};
