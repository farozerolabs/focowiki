export function readUploadSourceFileId(file) {
  return typeof file?.sourceFileId === "string" && file.sourceFileId
    ? file.sourceFileId
    : null;
}

export function readAdminSourceFileId(file) {
  return typeof file?.id === "string" && file.id ? file.id : null;
}

export function readAdminSourceFileModelName(file) {
  return typeof file?.modelInvocationModelName === "string"
    && file.modelInvocationModelName.trim().length > 0
    ? file.modelInvocationModelName.trim()
    : null;
}

export function matchAdminSourceFilesToSamples(files, samples) {
  const expectedPaths = new Set(
    samples.map((sample) => sample.relativePath ?? sample.basename)
  );

  return files.filter((file) => expectedPaths.has(file.relativePath));
}
