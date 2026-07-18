import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    fileParallelism: !process.env.FOCOWIKI_TEST_DATABASE_URL,
    server: {
      deps: {
        external: ["typescript"]
      }
    }
  }
});
