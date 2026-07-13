import { randomUUID } from "node:crypto";
import type { ApplicationRuntime } from "../../application/ports/runtime.js";

export const systemApplicationRuntime: ApplicationRuntime = {
  clock: {
    now: () => new Date()
  },
  ids: {
    create: (prefix) => `${prefix}-${randomUUID()}`
  }
};
