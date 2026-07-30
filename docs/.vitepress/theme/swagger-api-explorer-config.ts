export type SwaggerApiExplorerConfigInput = {
  domNode: HTMLElement;
  spec: Record<string, unknown>;
};

function createReadOnlyComponentsPlugin() {
  const hiddenControl = () => null;
  return {
    components: {
      authorizeBtn: hiddenControl,
      authorizeOperationBtn: hiddenControl,
      ServersContainer: hiddenControl
    }
  };
}

export function createSwaggerApiExplorerConfig({
  domNode,
  spec
}: SwaggerApiExplorerConfigInput): Record<string, unknown> {
  return {
    domNode,
    spec,
    deepLinking: true,
    filter: false,
    docExpansion: "none",
    defaultModelsExpandDepth: 1,
    defaultModelExpandDepth: 1,
    displayOperationId: true,
    plugins: [createReadOnlyComponentsPlugin],
    persistAuthorization: false,
    supportedSubmitMethods: [],
    tryItOutEnabled: false,
    validatorUrl: null
  };
}
