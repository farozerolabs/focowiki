import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { createStorageVnextProcessResourceScope } from
  "../src/storage-vnext/cleanup/process-resource-scope.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext real process resource closure", () => {
  it("reaps a subprocess and returns database and search connections", async () => {
    const connectionUrl = databaseUrl
      ?? "postgres://unused:unused@127.0.0.1:5432/unused";
    const applicationName = `svnext_resource_${(runOwner ?? "invalid").replaceAll("-", "_")}`;
    const observer = postgres(connectionUrl, { max: 1 });
    const database = postgres(connectionUrl, {
      max: 1,
      connection: { application_name: applicationName }
    });
    const searchClose = vi.fn(async () => undefined);
    let child: ChildProcess | null = null;
    try {
      await database`SELECT 1`;
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore"
      });
      await once(child, "spawn");
      const exited = once(child, "exit").then(() => undefined);
      const scope = createStorageVnextProcessResourceScope({ maximumResources: 4 });
      scope.trackClosable({
        publicId: "database-real",
        kind: "database_connection",
        close: async () => database.end({ timeout: 5 })
      });
      scope.trackClosable({
        publicId: "search-real-boundary",
        kind: "search_connection",
        close: searchClose
      });
      scope.trackSubprocess({
        publicId: "subprocess-real",
        hasExited: () => child?.exitCode !== null || child?.signalCode !== null,
        kill: () => { child?.kill("SIGTERM"); },
        exited
      });

      await scope.closeAll();

      scope.assertIdle();
      expect(searchClose).toHaveBeenCalledOnce();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      const rows = await observer<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM pg_stat_activity
        WHERE application_name = ${applicationName}
      `;
      expect(rows[0]?.count).toBe("0");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => undefined);
      }
      await database.end({ timeout: 1 }).catch(() => undefined);
      await observer.end({ timeout: 5 });
    }
  }, 30_000);
});
