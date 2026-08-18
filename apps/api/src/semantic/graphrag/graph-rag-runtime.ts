import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { GraphRagAdapterError } from "./contracts.js";
import {
  createGraphRagPythonPool,
  type GraphRagPythonPool
} from "./python-pool.js";
import {
  spawnGraphRagPythonProcess,
  type GraphRagPythonProcess
} from "./python-process.js";

const DEFAULT_POOL_SIZE = 1;
const MINIMUM_CONCURRENT_DOCUMENT_POOL_SIZE = 2;
const MAXIMUM_DOCUMENT_POOL_SIZE = 4;
const DOCUMENTS_PER_GRAPHRAG_PROCESS = 8;
const DEFAULT_MAXIMUM_BACKLOG = 8;
const DEFAULT_MAXIMUM_TASKS_PER_CHILD = 100;

export type GraphRagDocumentRuntime = {
  pool: GraphRagPythonPool;
  start(): Promise<void>;
  close(): Promise<void>;
};

export function createGraphRagRuntime(input: {
  workingDirectory?: string;
  pythonExecutable?: string;
  nodeVersion?: string;
  poolSize?: number;
  maximumBacklog?: number;
  maximumTasksPerChild?: number;
  createChild?: () => GraphRagPythonProcess;
} = {}): GraphRagDocumentRuntime {
  assertSupportedNodeVersion(input.nodeVersion ?? process.versions.node);
  const pythonPath = resolvePythonPath(input.workingDirectory ?? process.cwd());
  const createChild = input.createChild ?? (() => spawnGraphRagPythonProcess({
    pythonExecutable: input.pythonExecutable ?? "python3",
    pythonPath
  }));
  const pool = createGraphRagPythonPool({
    size: input.poolSize ?? DEFAULT_POOL_SIZE,
    maximumBacklog: input.maximumBacklog ?? DEFAULT_MAXIMUM_BACKLOG,
    maximumTasksPerChild: input.maximumTasksPerChild ?? DEFAULT_MAXIMUM_TASKS_PER_CHILD,
    createChild
  });
  return {
    pool,
    start: () => pool.start(),
    close: () => pool.close()
  };
}

export function resolveGraphRagPoolSize(sourceConcurrency: number): number {
  if (!Number.isSafeInteger(sourceConcurrency)
    || sourceConcurrency < 1 || sourceConcurrency > 32) {
    throw new GraphRagAdapterError(
      "INVALID_POOL_LIMIT",
      "sourceConcurrency must be an integer between 1 and 32"
    );
  }
  if (sourceConcurrency === 1) return 1;
  return Math.min(
    MAXIMUM_DOCUMENT_POOL_SIZE,
    Math.max(
      MINIMUM_CONCURRENT_DOCUMENT_POOL_SIZE,
      Math.ceil(sourceConcurrency / DOCUMENTS_PER_GRAPHRAG_PROCESS)
    )
  );
}

export function resolvePythonPath(workingDirectory: string): string {
  const workspacePath = resolve(workingDirectory, "apps/api/python");
  if (existsSync(workspacePath)) return workspacePath;
  const packagePath = resolve(workingDirectory, "python");
  if (existsSync(packagePath)) return packagePath;
  throw new GraphRagAdapterError(
    "GRAPHRAG_ADAPTER_PATH_MISSING",
    "GraphRAG adapter package is unavailable"
  );
}

export function assertSupportedNodeVersion(version: string): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major !== 24) {
    throw new GraphRagAdapterError(
      "NODE_RUNTIME_MISMATCH",
      "The unified worker requires Node.js 24"
    );
  }
}
