import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const RUNTIME_SERVICE_ORDER = Object.freeze([
  "api",
  "source-worker",
  "publication-worker",
  "maintenance-worker"
]);

export function createRuntimeServiceDefinitions(runtimeRoot) {
  const root = path.resolve(runtimeRoot);
  return {
    api: definition("api", path.join(root, "main.mjs")),
    "source-worker": definition(
      "source-worker",
      path.join(root, "source-worker.mjs"),
      256
    ),
    "publication-worker": definition(
      "publication-worker",
      path.join(root, "publication-worker.mjs"),
      512
    ),
    "maintenance-worker": definition(
      "maintenance-worker",
      path.join(root, "maintenance-worker.mjs")
    )
  };
}

export function createRuntimeServiceSupervisor(input) {
  const definitions = createRuntimeServiceDefinitions(input.runtimeRoot);
  const children = new Map();
  const exits = new Map();
  const evidenceDir = path.resolve(input.evidenceDir);
  fs.mkdirSync(evidenceDir, { recursive: true });

  return {
    definitions,
    listRunning() {
      return [...children.keys()].filter((serviceName) =>
        this.isRunning(serviceName)
      );
    },
    isRunning(serviceName) {
      const child = children.get(serviceName);
      return Boolean(
        child &&
        child.exitCode === null &&
        child.signalCode === null &&
        !child.killed
      );
    },
    assertRunning(serviceName) {
      if (!this.isRunning(serviceName)) {
        throw new Error(`Runtime service is not running: ${serviceName}.`);
      }
      return true;
    },
    captureState() {
      return { running: this.listRunning() };
    },
    async start(serviceName) {
      const service = definitions[serviceName];
      if (!service) throw new Error(`Unknown runtime service: ${serviceName}.`);
      if (children.has(serviceName)) return children.get(serviceName);
      if (!fs.existsSync(service.entrypoint)) {
        throw new Error(`Runtime entrypoint is missing for ${serviceName}.`);
      }

      const logPath = path.join(evidenceDir, `${serviceName}.log`);
      const logStream = fs.createWriteStream(logPath, { flags: "a" });
      const child = spawn(process.execPath, [...service.execArgv, service.entrypoint], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.pipe(logStream);
      child.stderr.pipe(logStream);
      child.once("exit", (code, signal) => {
        children.delete(serviceName);
        exits.set(serviceName, {
          code,
          signal,
          exitedAt: new Date().toISOString()
        });
        logStream.end();
      });
      children.set(serviceName, child);
      return child;
    },
    async stop(serviceName, timeoutMs = 15_000) {
      const child = children.get(serviceName);
      if (!child) return;
      child.kill("SIGTERM");
      const exited = await waitForExit(child, timeoutMs);
      if (!exited) {
        child.kill("SIGKILL");
        await waitForExit(child, 5_000);
      }
      children.delete(serviceName);
    },
    async startAll() {
      for (const serviceName of RUNTIME_SERVICE_ORDER) {
        await this.start(serviceName);
      }
    },
    async stopAll() {
      for (const serviceName of [...RUNTIME_SERVICE_ORDER].reverse()) {
        await this.stop(serviceName);
      }
    },
    async restore(capturedState) {
      const expected = new Set(capturedState?.running ?? []);
      for (const serviceName of [...RUNTIME_SERVICE_ORDER].reverse()) {
        if (!expected.has(serviceName)) await this.stop(serviceName);
      }
      for (const serviceName of RUNTIME_SERVICE_ORDER) {
        if (expected.has(serviceName)) await this.start(serviceName);
      }
      for (const serviceName of expected) this.assertRunning(serviceName);
    },
    exitState(serviceName) {
      return exits.get(serviceName) ?? null;
    }
  };
}

function definition(name, entrypoint, maximumOldSpaceMiB = null) {
  return {
    name,
    entrypoint,
    execArgv: maximumOldSpaceMiB === null
      ? []
      : [`--max-old-space-size=${maximumOldSpaceMiB}`]
  };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}
