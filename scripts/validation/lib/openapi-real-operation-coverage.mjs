const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"]);
const AUTHORIZATION_MODES = new Set(["authenticated", "unauthenticated"]);

export function createOpenApiOperationCoverage(openApiDocument) {
  const operations = collectOperations(openApiDocument);
  const attemptsByOperation = new Map(
    operations.map((operation) => [operation.operationId, []])
  );

  return {
    operationCount: operations.length,

    record(input) {
      const method = String(input.method ?? "GET").toUpperCase();
      const pathname = new URL(String(input.pathname), "http://openapi.local").pathname;
      const authorization = String(input.authorization ?? "");
      const status = Number(input.status);
      if (!AUTHORIZATION_MODES.has(authorization)) {
        throw new Error(`Unsupported OpenAPI authorization mode: ${authorization}`);
      }
      if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
        throw new Error(`Invalid OpenAPI response status: ${input.status}`);
      }
      const operation = operations.find(
        (candidate) => candidate.method === method && candidate.pattern.test(pathname)
      );
      if (!operation) {
        throw new Error(`${method} ${pathname} does not match a released OpenAPI operation.`);
      }
      attemptsByOperation.get(operation.operationId).push({
        authorization,
        status
      });
      return operation.operationId;
    },

    summary(options = {}) {
      const acceptedStatuses = options.acceptedAuthenticatedStatuses ?? {};
      const operationResults = operations.map((operation) => {
        const attempts = attemptsByOperation.get(operation.operationId);
        const unauthenticatedStatuses = uniqueStatuses(attempts, "unauthenticated");
        const authenticatedStatuses = uniqueStatuses(attempts, "authenticated");
        const authenticationVerified = unauthenticatedStatuses.includes(401);
        const operationAcceptedStatuses = acceptedStatuses[operation.operationId] ?? [];
        const businessPathVerified = authenticatedStatuses.some(
          (status) => (status >= 200 && status < 300)
            || operationAcceptedStatuses.includes(status)
        );
        return {
          operationId: operation.operationId,
          method: operation.method,
          path: operation.path,
          authenticationVerified,
          businessPathVerified,
          unauthenticatedStatuses,
          authenticatedStatuses
        };
      });
      const missingAuthentication = operationResults
        .filter((operation) => !operation.authenticationVerified)
        .map((operation) => operation.operationId);
      const missingBusinessPath = operationResults
        .filter((operation) => !operation.businessPathVerified)
        .map((operation) => operation.operationId);
      return {
        operationCount: operationResults.length,
        complete: missingAuthentication.length === 0 && missingBusinessPath.length === 0,
        missingAuthentication,
        missingBusinessPath,
        operations: operationResults
      };
    }
  };
}

function collectOperations(document) {
  const operations = [];
  for (const [pathname, pathItem] of Object.entries(document?.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method) || !operation?.operationId) continue;
      const parameterCount = (pathname.match(/\{[^}]+\}/gu) ?? []).length;
      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: pathname,
        pattern: compilePathPattern(pathname),
        parameterCount,
        literalLength: pathname.replace(/\{[^}]+\}/gu, "").length
      });
    }
  }
  operations.sort((left, right) =>
    left.parameterCount - right.parameterCount
      || right.literalLength - left.literalLength
      || left.operationId.localeCompare(right.operationId)
  );
  return operations;
}

function compilePathPattern(pathname) {
  const segments = pathname.split("/").map((segment) =>
    /^\{[^}]+\}$/u.test(segment) ? "[^/]+" : escapeRegularExpression(segment)
  );
  return new RegExp(`^${segments.join("/")}$`, "u");
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function uniqueStatuses(attempts, authorization) {
  return [...new Set(
    attempts
      .filter((attempt) => attempt.authorization === authorization)
      .map((attempt) => attempt.status)
  )].sort((left, right) => left - right);
}
