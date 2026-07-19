export class PublicationCatalogStaleError extends Error {
  public constructor() {
    super("Publication catalog generation is stale");
    this.name = "PublicationCatalogStaleError";
  }
}

export class PublicationGenerationBusyError extends Error {
  public constructor() {
    super("Another publication generation is already in progress");
    this.name = "PublicationGenerationBusyError";
  }
}
