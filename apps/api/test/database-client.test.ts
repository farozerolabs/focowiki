import { describe, expect, it } from "vitest";
import { createDatabaseClientOptions } from "../src/db/client.js";

describe("database client role options", () => {
  it("reclaims worker high-water connections between bounded polling intervals", () => {
    const database = {
      poolMax: 10,
      sourceWorkerPoolMax: 6,
      publicationWorkerPoolMax: 4,
      maintenanceWorkerPoolMax: 2
    };

    expect(createDatabaseClientOptions(database, "api")).toMatchObject({
      max: 10,
      idle_timeout: 20
    });
    expect(createDatabaseClientOptions(database, "source-worker")).toMatchObject({
      max: 6,
      idle_timeout: 5
    });
    expect(createDatabaseClientOptions(database, "publication-worker")).toMatchObject({
      max: 4,
      idle_timeout: 5
    });
    expect(createDatabaseClientOptions(database, "maintenance-worker")).toMatchObject({
      max: 2,
      idle_timeout: 5
    });
  });
});
