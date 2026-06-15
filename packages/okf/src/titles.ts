export function knowledgeBaseTitle(title: string | undefined): string {
  return title?.trim() || "Knowledge base";
}

export function bundleSchemaTitle(title: string | undefined): string {
  return `${knowledgeBaseTitle(title)} schema`;
}
