import { Hono, type MiddlewareHandler } from "hono";
import { type RuntimeConfig } from "../config.js";
import type { AdminSessionManager } from "../auth/session.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import {
  adminUnauthorized,
  missingSessionBackend
} from "./security.js";
import { registerAdminFileTreeRoutes } from "./file-tree-routes.js";
import { registerAdminFileTreeSearchRoutes } from "./file-tree-search-routes.js";
import { registerAdminKnowledgeBaseListRoutes } from "./knowledge-base-list-routes.js";
import { registerAdminOpenApiKeyRoutes } from "./openapi-key-routes.js";
import { readPageLimit } from "./pagination.js";
import { registerAdminProcessingSummaryRoutes } from "./processing-summary-routes.js";
import { registerAdminPublicUrlRoutes } from "./public-url-routes.js";
import { registerAdminRuntimeSettingsRoutes } from "./runtime-settings-routes.js";
import { registerAdminSourceFileRetryRoutes } from "./source-file-retry-routes.js";
import { registerAdminSourceFileTaskDeletionRoutes } from "./source-file-task-deletion-routes.js";
import {
  readSourceFileListFiltersFromQuery,
  type SourceFileListFilterErrorCode
} from "./source-file-list-filters.js";
import { registerAdminUploadSessionRoutes } from "./upload-session-routes.js";
import { registerAdminSourceResourceEditingRoutes } from "./source-resource-editing-routes.js";
import {
  registerAdminKnowledgeBaseIndexMaintenanceRoutes
} from "./knowledge-base-index-maintenance-routes.js";
import type { StorageVnextAdminReadApplication } from "../storage-vnext/api/admin-read-application.js";
import type { StorageVnextAdminProcessingApplication } from "../storage-vnext/api/admin-processing-application.js";
import type { StorageVnextAdminSourceApplication } from "../storage-vnext/api/admin-source-application.js";
import type { StorageVnextAdminAuditApplication } from "../storage-vnext/api/admin-audit-application.js";
import type { StorageVnextAdminMaintenanceApplication } from "../storage-vnext/api/admin-maintenance-application.js";
import type { StorageVnextAdminUploadApplication } from "../storage-vnext/api/admin-upload-application.js";
import type { StorageVnextAdminOpenApiKeyApplication } from "../storage-vnext/api/admin-openapi-key-application.js";
import type { StorageVnextAdminMutationApplication } from "../storage-vnext/api/admin-mutation-application.js";
import type { StorageVnextAdminCoreApplication } from "../storage-vnext/api/admin-core-application.js";
import type { StorageVnextAdminSecurityApplication } from "../storage-vnext/api/admin-security-application.js";
import type { EmbeddingConfigurationService } from
  "../semantic/embedding/service.js";
import { registerAdminEmbeddingSettingsRoutes } from
  "./embedding-settings-routes.js";
import type { RerankerConfigurationService } from
  "../semantic/reranker/service.js";
import { registerAdminRerankerSettingsRoutes } from
  "./reranker-settings-routes.js";

export type AdminApiServices = {
  adminApplication: StorageVnextAdminReadApplication;
  adminAuditApplication: StorageVnextAdminAuditApplication;
  adminMaintenanceApplication: StorageVnextAdminMaintenanceApplication;
  adminUploadApplication: StorageVnextAdminUploadApplication;
  adminOpenApiKeyApplication: StorageVnextAdminOpenApiKeyApplication;
  adminMutationApplication: StorageVnextAdminMutationApplication;
  adminCoreApplication: StorageVnextAdminCoreApplication;
  adminSecurityApplication: StorageVnextAdminSecurityApplication;
  adminProcessingApplication: StorageVnextAdminProcessingApplication;
  adminSourceApplication: StorageVnextAdminSourceApplication;
  config: RuntimeConfig;
  sessionManager: AdminSessionManager | null;
  runtimeSettings: RuntimeSettingsService | null;
  embeddingConfigurations: EmbeddingConfigurationService | null;
  rerankerConfigurations: RerankerConfigurationService | null;
};

export function registerAdminApiRoutes(app: Hono, services: AdminApiServices): void {
  const { config, sessionManager, runtimeSettings } = services;
  const { requireAuth, requireWriteProtection } = services.adminSecurityApplication;
  services.adminSecurityApplication.register(app);

  registerAdminOpenApiKeyRoutes(
    app,
    {
      config,
      application: services.adminOpenApiKeyApplication,
      audit: services.adminAuditApplication
    },
    {
      requireAuth,
      requireWriteProtection
    }
  );
  registerAdminRuntimeSettingsRoutes(
    app,
    { runtimeSettings },
    {
      requireAuth,
      requireWriteProtection
    }
  );
  registerAdminEmbeddingSettingsRoutes(
    app,
    {
      embeddingConfigurations: services.embeddingConfigurations,
      actorPublicId: config.admin.username
    },
    { requireAuth, requireWriteProtection }
  );
  registerAdminRerankerSettingsRoutes(
    app,
    {
      rerankerConfigurations: services.rerankerConfigurations,
      actorPublicId: config.admin.username
    },
    { requireAuth, requireWriteProtection }
  );
  registerAdminSourceFileRetryRoutes(
    app,
    {
      application: services.adminSourceApplication
    },
    {
      requireAuth,
      requireWriteProtection
    }
  );
  registerAdminSourceFileTaskDeletionRoutes(
    app,
    {
      config,
      application: services.adminSourceApplication
    },
    {
      requireAuth,
      requireWriteProtection
    }
  );
  registerAdminFileTreeRoutes(
    app,
    {
      config,
      application: services.adminApplication
    },
    {
      requireAuth
    }
  );
  registerAdminFileTreeSearchRoutes(
    app,
    {
      config,
      application: services.adminApplication
    },
    { requireAuth }
  );
  registerAdminSourceResourceEditingRoutes(
    app,
    {
      config,
      application: services.adminMutationApplication,
      audit: services.adminAuditApplication
    },
    { requireAuth, requireWriteProtection }
  );
  registerAdminProcessingSummaryRoutes(
    app,
    {
      application: services.adminProcessingApplication
    },
    {
      requireAuth
    }
  );
  registerAdminKnowledgeBaseIndexMaintenanceRoutes(
    app,
    {
      application: services.adminMaintenanceApplication,
      audit: services.adminAuditApplication
    },
    {
      requireAuth,
      requireWriteProtection
    }
  );
  registerAdminPublicUrlRoutes(
    app,
    { config, application: services.adminApplication },
    {
      requireAuth
    }
  );
  registerAdminKnowledgeBaseListRoutes(
    app,
    { config, application: services.adminApplication },
    {
      requireAuth
    }
  );
  registerAdminUploadSessionRoutes(
    app,
    {
      application: services.adminUploadApplication,
      audit: services.adminAuditApplication
    },
    { requireAuth, requireWriteProtection }
  );

  app.post("/admin/api/login", async (context) => {
    if (containsCredentialQuery(context.req.raw.url)) {
      return context.json(
        {
          error: {
            code: "CREDENTIALS_IN_URL_NOT_ALLOWED"
          }
        },
        400
      );
    }

    if (!sessionManager) {
      return missingSessionBackend(context);
    }

    const body = await readJsonBody(context.req.raw);
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const loginLimited = await services.adminSecurityApplication.limitLogin({
      context,
      username
    });

    if (loginLimited) {
      return loginLimited;
    }

    if (!sessionManager.authenticate({ username, password })) {
      await services.adminAuditApplication.record({
        context,
        eventType: "admin_login",
        result: "failure",
        errorCode: "UNAUTHORIZED",
        username: username || null
      });
      return adminUnauthorized(context, "auth.invalidCredentials");
    }

    context.header("set-cookie", await sessionManager.createSessionCookie(username));
    await services.adminAuditApplication.record({
      context,
      eventType: "admin_login",
      result: "success",
      username
    });
    return context.json({ authenticated: true });
  });

  app.get("/admin/api/session", requireAuth, (context) =>
    context.json({ authenticated: true })
  );

  app.post("/admin/api/logout", requireAuth, requireWriteProtection, async (context) => {
    if (!sessionManager) {
      return missingSessionBackend(context);
    }

    await sessionManager.clearSessionFromCookieHeader(context.req.header("cookie"));
    context.header("set-cookie", sessionManager.createClearedSessionCookie());
    await services.adminAuditApplication.record({
      context,
      eventType: "admin_logout",
      result: "success"
    });
    return context.json({ authenticated: false });
  });

  app.post("/admin/api/knowledge-bases", requireAuth, requireWriteProtection, async (context) => {
    const input = readKnowledgeBaseCreateInput(await readJsonBody(context.req.raw));

    if (!input) {
      return context.json(
        {
          error: {
            code: "INVALID_KNOWLEDGE_BASE",
            messageKey: "errors.invalidKnowledgeBase"
          }
        },
        400
      );
    }

    const result = await services.adminCoreApplication.createKnowledgeBase(input);
    return result.ok
      ? context.json({ knowledgeBase: result.value }, 201)
      : missingRepositoryBackend(context);
  });

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId",
    requireAuth,
    async (context) => {
      const result = await services.adminCoreApplication.getKnowledgeBase({
        knowledgeBaseId: context.req.param("knowledgeBaseId")
      });
      if (!result.ok) {
        return result.code === "NOT_FOUND"
          ? notFound(context)
          : missingRepositoryBackend(context);
      }
      return context.json({ knowledgeBase: result.value });
    }
  );

  app.delete(
    "/admin/api/knowledge-bases/:knowledgeBaseId",
    requireAuth,
    requireWriteProtection,
    async (context) => {
      const result = await services.adminCoreApplication.deleteKnowledgeBase({
        knowledgeBaseId: context.req.param("knowledgeBaseId")
      });
      if (!result.ok) {
        return result.code === "NOT_FOUND"
          ? notFound(context)
          : missingRepositoryBackend(context);
      }
      return context.json(result.value);
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/files/detail",
    requireAuth,
    async (context) => {
      const logicalPath = context.req.query("path");

      if (!logicalPath) {
        return notFound(context);
      }
      const includeRelationships = context.req.query("includeRelationships") === "1";

      const result = await services.adminCoreApplication.readGeneratedContent({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        logicalPath,
        includeRelationships
      });
      if (!result.ok) {
        return result.code === "NOT_FOUND"
          ? notFound(context)
          : missingRepositoryBackend(context);
      }
      return result.value instanceof Response
        ? result.value
        : context.json(result.value);
    }
  );

  app.delete(
    "/admin/api/knowledge-bases/:knowledgeBaseId/files/detail",
    requireAuth,
    requireWriteProtection,
    async (context) => {
      const logicalPath = context.req.query("path");

      if (!logicalPath) {
        return notFound(context);
      }

      const result = await services.adminCoreApplication.deleteSourceFile({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        logicalPath
      });

      if (!result.ok) {
        if (result.code === "FILE_NOT_DELETABLE") return fileNotDeletable(context);
        return result.code === "NOT_FOUND"
          ? notFound(context)
          : missingRepositoryBackend(context);
      }
      return context.json(result.value, 200);
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files",
    requireAuth,
    async (context) => {
      const limit = readPageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const filters = readSourceFileListFiltersFromQuery((name) => context.req.query(name));

      if (!filters.ok) {
        return invalidSourceFileFilter(context, filters.code);
      }

      const result = await services.adminCoreApplication.listFiles({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        limit,
        cursor: context.req.query("cursor") ?? null,
        filters: filters.filters
      });
      if (!result.ok) {
        if (result.code === "INVALID_PAGINATION") return invalidPagination(context);
        return result.code === "NOT_FOUND"
          ? notFound(context)
          : missingRepositoryBackend(context);
      }
      return context.json(result.value);
    }
  );

  app.get(
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    requireAuth,
    async (context) => {
      const limit = readPageLimit(context.req.query("limit"), config);

      if (!limit) {
        return invalidPagination(context);
      }

      const result = await services.adminCoreApplication.getFile({
        knowledgeBaseId: context.req.param("knowledgeBaseId"),
        sourceFileId: context.req.param("sourceFileId"),
        limit,
        cursor: context.req.query("cursor") ?? null
      });
      if (!result.ok) {
        if (result.code === "INVALID_PAGINATION") return invalidPagination(context);
        return result.code === "NOT_FOUND"
          ? notFound(context)
          : missingRepositoryBackend(context);
      }
      return context.json(result.value);
    }
  );

}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function missingRepositoryBackend(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "DATABASE_REPOSITORY_UNAVAILABLE"
      }
    },
    503
  );
}

function invalidPagination(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "INVALID_PAGINATION"
      }
    },
    400
  );
}

function invalidSourceFileFilter(
  context: Parameters<MiddlewareHandler>[0],
  code: SourceFileListFilterErrorCode = "INVALID_SOURCE_FILE_FILTER"
): Response {
  return context.json(
    {
      error: {
        code
      }
    },
    400
  );
}

function containsCredentialQuery(rawUrl: string): boolean {
  const searchParams = new URL(rawUrl).searchParams;
  return (
    searchParams.has("token") ||
    searchParams.has("username") ||
    searchParams.has("password")
  );
}

function readKnowledgeBaseCreateInput(
  body: Record<string, unknown>
): { name: string; description: string | null } | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    return null;
  }

  if (
    body.description !== undefined
    && body.description !== null
    && typeof body.description !== "string"
  ) {
    return null;
  }

  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim()
      : null;

  return {
    name,
    description
  };
}

function notFound(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "NOT_FOUND"
      }
    },
    404
  );
}

function fileNotDeletable(context: Parameters<MiddlewareHandler>[0]): Response {
  return context.json(
    {
      error: {
        code: "FILE_NOT_DELETABLE",
        messageKey: "errors.fileNotDeletable"
      }
    },
    400
  );
}
