import {
  renderJsonCollectionRootFile,
  renderJsonCollectionShardFile,
  type BundleFileKind,
  type GeneratedOkfFile,
  type JsonCollectionShardDescriptor
} from "./publication-files.js";

export type JsonShardWriter<T> = {
  add: (item: T) => Promise<void>;
  addMany: (items: T[]) => Promise<void>;
  finishRoot: () => Promise<GeneratedOkfFile>;
  readonly itemCount: number;
};

export function createJsonShardWriter<T>(input: {
  generatedAt: string;
  rootPath: string;
  shardDirectory: string;
  rootKind: BundleFileKind;
  shardKind: BundleFileKind;
  collectionKey: string;
  shardSize: number;
  persistFiles: (files: GeneratedOkfFile[]) => Promise<void>;
}): JsonShardWriter<T> {
  const buffer: T[] = [];
  const shards: JsonCollectionShardDescriptor[] = [];
  let itemCount = 0;
  let shardIndex = 0;

  const flushShard = async (): Promise<void> => {
    if (buffer.length === 0) {
      return;
    }

    const items = buffer.splice(0, buffer.length);
    const path = `${input.shardDirectory}/${String(shardIndex + 1).padStart(6, "0")}.jsonl`;
    await input.persistFiles([
      renderJsonCollectionShardFile({
        logicalPath: path,
        shardKind: input.shardKind,
        items
      })
    ]);
    shards.push({ path, count: items.length });
    itemCount += items.length;
    shardIndex += 1;
  };

  return {
    get itemCount() {
      return itemCount + buffer.length;
    },
    async add(item) {
      buffer.push(item);
      if (buffer.length >= input.shardSize) {
        await flushShard();
      }
    },
    async addMany(items) {
      for (const item of items) {
        await this.add(item);
      }
    },
    async finishRoot() {
      if (shards.length === 0 && buffer.length < input.shardSize) {
        const inlineItems = buffer.splice(0, buffer.length);
        itemCount += inlineItems.length;
        return renderJsonCollectionRootFile<T>({
          generatedAt: input.generatedAt,
          rootPath: input.rootPath,
          rootKind: input.rootKind,
          collectionKey: input.collectionKey,
          itemCount,
          shardSize: input.shardSize,
          shards,
          inlineItems
        });
      }

      await flushShard();
      return renderJsonCollectionRootFile({
        generatedAt: input.generatedAt,
        rootPath: input.rootPath,
        rootKind: input.rootKind,
        collectionKey: input.collectionKey,
        itemCount,
        shardSize: input.shardSize,
        shards
      });
    }
  };
}
