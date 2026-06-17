import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeveloperOpenApiDocument } from "../../apps/api/src/developer-openapi/openapi-document.js";

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), "focowiki-openapi-"));
  const contractPath = join(tempDir, "focowiki-openapi.json");

  try {
    await writeFile(
      contractPath,
      `${JSON.stringify(createDeveloperOpenApiDocument(), null, 2)}\n`,
      "utf8"
    );
    await runRedocly(["lint", contractPath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runRedocly(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "redocly.cmd" : "redocly";
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`redocly exited with code ${code ?? "null"}.`));
    });
  });
}

await main();
