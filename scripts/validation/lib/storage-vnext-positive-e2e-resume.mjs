export function resolveCompletedUploadSessionId(input) {
  const { report, runId, knowledgeBaseId, sampleCount } = input;
  if (
    report?.runId !== runId
    || report?.knowledgeBaseId !== knowledgeBaseId
    || report?.sampleCount !== sampleCount
  ) return null;

  if (typeof report.completedUploadSessionId === "string") {
    return report.completedUploadSessionId;
  }

  const phases = [
    ...(report.phases ?? []),
    ...(report.resumedFrom?.phases ?? [])
  ];
  const completed = [...phases].reverse().find((entry) => (
    entry.name === "upload-completed" || entry.name === "upload-resumed"
  ));
  return typeof completed?.details?.sessionId === "string"
    ? completed.details.sessionId
    : null;
}
