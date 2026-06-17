import { spawn, spawnSync } from "node:child_process";

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio || "pipe",
    encoding: "utf8"
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `: ${output.slice(-1000)}` : ""}`);
  }

  return result;
}

export function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio || "ignore",
    detached: false
  });

  child.once("exit", (code) => {
    if (code && options.onUnexpectedExit) {
      options.onUnexpectedExit(code);
    }
  });

  return {
    label: options.label || command,
    child,
    stop: () => stopProcess(child)
  };
}

export async function stopManagedProcesses(processes) {
  for (const processHandle of [...processes].reverse()) {
    await processHandle.stop();
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
