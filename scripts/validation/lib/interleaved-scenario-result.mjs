const DEFAULT_ERROR_CODE = "SCENARIO_FAILED";
const MAX_ERROR_MESSAGE_LENGTH = 500;

export function buildScenarioFailure(error, options = {}) {
  const workspacePath = options.workspacePath?.trim();
  let errorMessage = String(error?.message ?? DEFAULT_ERROR_CODE);
  if (workspacePath) {
    errorMessage = errorMessage.replaceAll(workspacePath, "<workspace>");
  }

  return {
    errorCode: String(error?.code ?? DEFAULT_ERROR_CODE),
    errorMessage: errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH)
  };
}
