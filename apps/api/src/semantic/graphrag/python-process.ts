import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  GraphRagAdapterError,
  parseGraphRagAdapterResponse,
  type GraphRagAdapterRequest,
  type GraphRagAdapterResponse
} from "./contracts.js";
import {
  createGraphRagFrameDecoder,
  DEFAULT_MAXIMUM_GRAPHRAG_FRAME_BYTES,
  encodeGraphRagFrame
} from "./frame-codec.js";

export type GraphRagPythonProcess = {
  readonly pid: number | undefined;
  request(value: GraphRagAdapterRequest): Promise<GraphRagAdapterResponse>;
  terminate(): void | Promise<void>;
};

export function spawnGraphRagPythonProcess(input: {
  pythonExecutable: string;
  modulePath?: string;
  pythonPath: string;
  maximumFrameBytes?: number;
  terminationGraceMs?: number;
  spawnProcess?: typeof spawn;
}): GraphRagPythonProcess {
  const maximumFrameBytes = input.maximumFrameBytes ?? DEFAULT_MAXIMUM_GRAPHRAG_FRAME_BYTES;
  const terminationGraceMs = input.terminationGraceMs ?? 2_000;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    throw new GraphRagAdapterError(
      "INVALID_TERMINATION_GRACE",
      "Adapter termination grace must be a positive integer"
    );
  }
  const spawnProcess = input.spawnProcess ?? spawn;
  const child = spawnProcess(
    input.pythonExecutable,
    ["-m", input.modulePath ?? "graphrag_adapter"],
    {
      env: { PATH: process.env.PATH, PYTHONPATH: input.pythonPath, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    }
  ) as ChildProcessWithoutNullStreams;
  let pending: {
    requestId: string;
    resolve(value: GraphRagAdapterResponse): void;
    reject(error: Error): void;
  } | null = null;
  let terminalError: GraphRagAdapterError | null = null;
  let termination: Promise<void> | null = null;
  const fail = (error: GraphRagAdapterError): void => {
    terminalError ??= error;
    const current = pending;
    pending = null;
    current?.reject(error);
  };
  const decoder = createGraphRagFrameDecoder({
    maximumBytes: maximumFrameBytes,
    onFrame(value) {
      const current = pending;
      if (!current) {
        fail(new GraphRagAdapterError("UNEXPECTED_ADAPTER_FRAME", "Adapter returned an unexpected frame"));
        child.kill("SIGKILL");
        return;
      }
      try {
        const response = parseGraphRagAdapterResponse(value);
        if (response.requestId !== current.requestId) {
          throw new GraphRagAdapterError("ADAPTER_REQUEST_MISMATCH", "Adapter response request identifier differs");
        }
        pending = null;
        current.resolve(response);
      } catch (error) {
        fail(error instanceof GraphRagAdapterError
          ? error
          : new GraphRagAdapterError("INVALID_ADAPTER_RESPONSE", "Adapter response is invalid"));
        child.kill("SIGKILL");
      }
    },
    onError(error) {
      fail(error);
      child.kill("SIGKILL");
    }
  });
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
  child.stdout.on("end", () => decoder.end());
  child.stderr.on("data", () => undefined);
  child.once("error", () => fail(new GraphRagAdapterError("ADAPTER_PROCESS_ERROR", "Adapter process failed")));
  child.once("exit", () => fail(new GraphRagAdapterError("ADAPTER_PROCESS_EXITED", "Adapter process exited")));

  return {
    get pid() {
      return child.pid;
    },
    request(value) {
      if (terminalError) return Promise.reject(terminalError);
      if (pending) {
        return Promise.reject(new GraphRagAdapterError("ADAPTER_PROCESS_BUSY", "Adapter process already has work"));
      }
      return new Promise<GraphRagAdapterResponse>((resolve, reject) => {
        pending = { requestId: value.requestId, resolve, reject };
        child.stdin.write(encodeGraphRagFrame(value, maximumFrameBytes), (error) => {
          if (error) fail(new GraphRagAdapterError("ADAPTER_WRITE_FAILED", "Adapter request write failed"));
        });
      });
    },
    terminate() {
      if (termination) return termination;
      termination = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        let completionTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (forceTimer) clearTimeout(forceTimer);
          if (completionTimer) clearTimeout(completionTimer);
          resolve();
        };
        child.once("close", finish);
        child.once("error", finish);
        child.stdin.end();
        child.kill("SIGTERM");
        forceTimer = setTimeout(() => {
          child.kill("SIGKILL");
          completionTimer = setTimeout(finish, 1_000);
          completionTimer.unref?.();
        }, terminationGraceMs);
        forceTimer.unref?.();
      });
      return termination;
    }
  };
}
