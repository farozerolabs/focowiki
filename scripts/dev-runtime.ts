import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type DevelopmentProcess = {
  name: string;
  command: string;
  args: string[];
};

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nodeCommand = process.execPath;
const processes: DevelopmentProcess[] = [
  {
    name: "admin",
    command: pnpmCommand,
    args: ["--filter", "@focowiki/admin", "dev"]
  },
  {
    name: "api",
    command: nodeCommand,
    args: ["--import", "tsx", "apps/api/src/main.ts"]
  },
  {
    name: "worker",
    command: nodeCommand,
    args: ["--import", "tsx", "apps/api/src/worker-main.ts"]
  }
];

const children = new Map<string, ChildProcess>();
let shuttingDown = false;

for (const processDefinition of processes) {
  const child = spawn(processDefinition.command, processDefinition.args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit"
  });
  children.set(processDefinition.name, child);
  child.once("error", (error) => {
    console.error(`[dev:${processDefinition.name}] failed to start`, error);
    void shutdown("SIGTERM", 1);
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[dev:${processDefinition.name}] exited unexpectedly`,
      { code, signal }
    );
    void shutdown("SIGTERM", code ?? 1);
  });
}

process.once("SIGINT", () => void shutdown("SIGINT", 0));
process.once("SIGTERM", () => void shutdown("SIGTERM", 0));

async function shutdown(signal: NodeJS.Signals, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...children.values()].map((child) => stopChild(child, signal)));
  process.exitCode = exitCode;
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStopped) => {
    child.once("exit", () => resolveStopped());
    child.kill(signal);
  });
}
