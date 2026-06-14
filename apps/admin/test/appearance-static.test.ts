import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("admin appearance defaults", () => {
  it("loads the app in dark mode by default", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8");

    expect(html).toContain('<html lang="en" class="dark">');
  });
});
