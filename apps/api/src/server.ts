import { Hono } from "hono";
import { createBaseApp } from "./app/base.js";
import type { ApiAppOptions } from "./app/api-app-options.js";
import { resolveApiAppServices } from "./app/api-app-services.js";
import { registerAdminApiRoutes } from "./admin/routes.js";
import { registerDeveloperOpenApiRoutes } from "./developer-openapi/routes.js";
export type { ApiAppOptions } from "./app/api-app-options.js";
export function createAdminApiApp(options: ApiAppOptions): Hono {
  const services = resolveApiAppServices(options);
  const app = createBaseApp(services.config, services.logger);
  registerAdminApiRoutes(app, services);

  return app;
}
export function createPublicOpenApiApp(options: ApiAppOptions): Hono {
  const services = resolveApiAppServices(options);
  const app = createBaseApp(services.config, services.logger);

  registerDeveloperOpenApiRoutes(app, services.developerOpenApiContext);

  return app;
}

export function createApiApp(options: ApiAppOptions): Hono {
  const services = resolveApiAppServices(options);
  const app = createBaseApp(services.config, services.logger);

  registerAdminApiRoutes(app, services);
  registerDeveloperOpenApiRoutes(app, services.developerOpenApiContext);

  return app;
}
