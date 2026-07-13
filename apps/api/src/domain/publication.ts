export class PublicationCatalogStaleError extends Error {
  public constructor() {
    super("Publication catalog generation is stale");
    this.name = "PublicationCatalogStaleError";
  }
}
