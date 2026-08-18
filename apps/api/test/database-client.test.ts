import { describe, expect, it } from "vitest";
import { createDatabaseClientOptions } from "../src/db/client.js";

describe("database client role options", () => {
  it("reclaims worker high-water connections between bounded polling intervals", () => {
    const database = {
      poolMax: 10,
      workerPoolMax: 8
    };

    expect(createDatabaseClientOptions(database, "api")).toMatchObject({
      max: 10,
      idle_timeout: 20
    });
    expect(createDatabaseClientOptions(database, "worker")).toMatchObject({
      max: 8,
      idle_timeout: 5
    });
  });
});
