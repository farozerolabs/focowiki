export async function readConsistentGeneratedContent(input) {
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    const byId = await input.readById();
    const byPath = await input.readByPath();
    const byIdGeneration = readGenerationId(byId);
    const byPathGeneration = readGenerationId(byPath);

    if (
      byIdGeneration !== byPathGeneration
      || (
        input.expectedGenerationId
        && byIdGeneration !== input.expectedGenerationId
      )
    ) {
      if (attempt + 1 < input.maxAttempts) {
        await input.wait();
        continue;
      }
      throw new Error(
        `Active generation did not stabilize while reading: ${input.logicalPath}`
      );
    }
    if (byId.file?.fileId !== byPath.file?.fileId) {
      throw new Error(
        `File identity mismatch within active generation ${byIdGeneration}: ${input.logicalPath}`
      );
    }
    if (byId.content !== byPath.content) {
      throw new Error(
        `File content mismatch within active generation ${byIdGeneration}: ${input.logicalPath}`
      );
    }

    return {
      content: byId.content,
      file: byId.file,
      generationId: byIdGeneration
    };
  }

  throw new Error(`Generated content read budget is invalid: ${input.logicalPath}`);
}

function readGenerationId(result) {
  const generationId = result?.file?.generationId;

  if (typeof generationId !== "string" || generationId.length === 0) {
    throw new Error("Generated file response is missing its active generation identity.");
  }

  return generationId;
}
