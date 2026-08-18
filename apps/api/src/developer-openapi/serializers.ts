type KnowledgeBaseRecord = {
  id: string;
  name: string;
  description: string | null;
  activeContentRevision: number;
  resourceRevision?: number;
  createdAt: string;
  updatedAt: string;
};

export function toDeveloperKnowledgeBase(record: KnowledgeBaseRecord) {
  return {
    knowledgeBaseId: record.id,
    name: record.name,
    description: record.description,
    activeContentRevision: record.activeContentRevision,
    resourceRevision: record.resourceRevision ?? 1,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}
