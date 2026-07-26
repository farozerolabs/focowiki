import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../../apps/api/package.json", import.meta.url)
);
const { createClient } = require("redis");

export function createInterleavedRedisEvidence(input) {
  const ownsClient = input.ownsClient ?? !input.client;
  const client = input.client ?? createClient({ url: input.redisUrl });

  return {
    async snapshot(options) {
      if (ownsClient && !client.isOpen) await client.connect();
      const keys = [];
      const byType = {};

      for await (const scanned of client.scanIterator({
        MATCH: options.match ?? "focowiki:*",
        COUNT: 500
      })) {
        const batch = Array.isArray(scanned) ? scanned : [scanned];
        for (const key of batch) {
          const type = await client.type(key);
          byType[type] = (byType[type] ?? 0) + 1;
          keys.push({
            alias: options.redactor.alias("redis_key", key),
            type
          });
        }
      }

      keys.sort((left, right) => left.alias.localeCompare(right.alias));
      return {
        capturedAt: new Date().toISOString(),
        totalKeys: keys.length,
        byType: Object.fromEntries(
          Object.entries(byType).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        ),
        keys
      };
    },
    async close() {
      if (!ownsClient || !client.isOpen) return;
      if (client.isReady) {
        await client.quit();
        return;
      }
      client.destroy();
    }
  };
}
