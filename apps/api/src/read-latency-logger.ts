import type { RuntimeLogger } from "./logger.js";

export function logReadLatency(input: {
  logger: RuntimeLogger;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}): void {
  const endpoint = classifyReadEndpoint(input.method, input.path);

  if (!endpoint) {
    return;
  }

  input.logger.info("API read request completed", {
    plane: endpoint.plane,
    endpoint: endpoint.name,
    status: input.status,
    durationMs: Math.round(input.durationMs)
  });
}

function classifyReadEndpoint(
  method: string,
  path: string
): { plane: "admin" | "developer_openapi"; name: string } | null {
  if (method !== "GET") {
    return null;
  }

  if (path.match(/^\/admin\/api\/knowledge-bases\/[^/]+\/source-files$/)) {
    return { plane: "admin", name: "source_file_list" };
  }

  if (path.match(/^\/admin\/api\/knowledge-bases\/[^/]+\/files\/tree$/)) {
    return { plane: "admin", name: "file_tree" };
  }

  if (path.match(/^\/admin\/api\/knowledge-bases\/[^/]+\/files\/detail$/)) {
    return { plane: "admin", name: "file_preview" };
  }

  if (path.match(/^\/openapi\/v2\/knowledge-bases\/[^/]+\/source-files$/)) {
    return { plane: "developer_openapi", name: "source_file_list" };
  }

  if (path.match(/^\/openapi\/v2\/knowledge-bases\/[^/]+\/tree$/)) {
    return { plane: "developer_openapi", name: "file_tree" };
  }

  if (path.includes("/openapi/v2/knowledge-bases/") && path.includes("/content")) {
    return { plane: "developer_openapi", name: "file_content" };
  }

  return null;
}
