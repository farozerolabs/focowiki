export const DEFAULT_LOCALE = "en-US" as const;
export const SUPPORTED_LOCALES = ["en-US", "zh-CN"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const resources = {
  "en-US": {
    translation: {
      app: {
        name: "Focowiki"
      },
      language: {
        switchLabel: "Language",
        english: "English",
        chinese: "Chinese"
      },
      auth: {
        title: "Admin access",
        description: "Enter the deployment admin credentials to manage Markdown bundle generation.",
        usernameLabel: "Username",
        usernamePlaceholder: "Enter username",
        passwordLabel: "Password",
        passwordPlaceholder: "Enter password",
        login: "Log in",
        loggingIn: "Logging in",
        logout: "Log out",
        sessionReady: "Admin session ready",
        invalidCredentials: "Invalid admin credentials"
      },
      common: {
        cancel: "Cancel",
        close: "Close",
        copy: "Copy",
        copied: "Copied"
      },
      pagination: {
        label: "Pagination",
        currentPage: "Page {{page}}",
        next: "Next page",
        previous: "Previous page",
        loading: "Loading page",
        expired: "This page expired. Reload the first page."
      },
      delete: {
        action: "Delete",
        confirm: "Delete",
        deleting: "Deleting",
        knowledgeBaseMenu: "Knowledge base actions for {{name}}",
        knowledgeBaseTitle: "Delete knowledge base",
        knowledgeBaseDescription: "Delete {{name}} from the admin console.",
        fileMenu: "File actions",
        fileTitle: "Delete Markdown file",
        fileDescription: "Delete {{name}} and republish the knowledge base."
      },
      home: {
        title: "Knowledge bases",
        knowledgeBasesTab: "Knowledge bases",
        openapiKeysTab: "OpenAPI keys",
        cardsTitle: "Knowledge bases",
        cardsDescription: "Create and open Markdown knowledge bases.",
        createAction: "Create knowledge base",
        createDescription: "Create a knowledge base before uploading Markdown sources.",
        createSubmit: "Create",
        creating: "Creating",
        emptyTitle: "No knowledge bases yet",
        emptyDescription: "Create the first knowledge base to start uploading Markdown sources.",
        loading: "Loading",
        loadMore: "Load more",
        searchLabel: "Search knowledge bases",
        searchPlaceholder: "Search by name, description, or ID",
        clearSearch: "Clear search",
        searchEmptyTitle: "No matching knowledge bases",
        searchEmptyDescription: "Try another name, description, or knowledge base ID.",
        nameLabel: "Knowledge base name",
        descriptionLabel: "Description",
        noDescription: "No description",
        knowledgeBaseIdLabel: "Knowledge base ID",
        copyKnowledgeBaseId: "Copy knowledge base ID {{id}}"
      },
      settings: {
        open: "Open settings",
        title: "Settings",
        loading: "Loading settings",
        save: "Save",
        saving: "Saving",
        tabs: {
          rateLimits: "API limits",
          worker: "Worker",
          publication: "Publication",
          uploadGeneration: "Upload and generation",
          models: "Models"
        },
        rateLimits: {
          title: "API limits",
          description: "Update admin and OpenAPI request limits without restarting the service."
        },
        worker: {
          title: "Worker",
          description: "Tune queue processing, backpressure, retry, and retention values."
        },
        publication: {
          title: "Publication",
          description: "Tune generated knowledge base publication and index shard values."
        },
        uploadGeneration: {
          title: "Upload and generation",
          description: "Tune upload request limits, S3 storage concurrency, and generation batch size."
        },
        publicationModes: {
          batch: "Batch",
          manual: "Manual",
          per_file: "Per file"
        },
        toast: {
          saveSuccess: "Settings saved",
          saveFailed: "Settings save failed",
          modelCreated: "Model created",
          modelUpdated: "Model updated",
          modelDeleted: "Model deleted",
          modelActionFailed: "Model action failed"
        },
        validation: {
          requiredPositiveInteger: "Required numeric fields must be positive integers."
        },
        tips: {
          title: "Tips",
          rateLimits: {
            adminLogin: {
              maxLabel: "Admin login / Max requests",
              maxDescription: "Maximum admin login attempts allowed in one counting window. Recommended: 8, or 5 to 10 for public deployments.",
              windowSecondsLabel: "Admin login / Window seconds",
              windowSecondsDescription: "Counting window for admin login attempts. Recommended: 900 seconds."
            },
            adminApi: {
              maxLabel: "Admin API / Max requests",
              maxDescription: "Maximum Admin UI API requests allowed in one counting window. Recommended: 600.",
              windowSecondsLabel: "Admin API / Window seconds",
              windowSecondsDescription: "Counting window for Admin UI API requests. Recommended: 60 seconds."
            },
            upload: {
              maxLabel: "Upload / Max requests",
              maxDescription: "Maximum Markdown upload requests allowed in one counting window. Recommended: 20.",
              windowSecondsLabel: "Upload / Window seconds",
              windowSecondsDescription: "Counting window for Markdown upload requests. Recommended: 3600 seconds."
            },
            publicOpenApi: {
              maxLabel: "Developer OpenAPI / Max requests",
              maxDescription: "Maximum Developer OpenAPI requests allowed in one counting window. Recommended: 1200, then tune by server capacity and traffic.",
              windowSecondsLabel: "Developer OpenAPI / Window seconds",
              windowSecondsDescription: "Counting window for Developer OpenAPI requests. Recommended: 60 seconds."
            }
          },
          worker: {
            sourceFileConcurrency: "Number of source files processed at the same time. Recommended: 2 to 4 on an 8C/32G server.",
            claimBatchSize: "Number of jobs claimed in one poll. Recommended: 10 to 50 and close to actual concurrency.",
            pollIntervalMs: "How often the worker checks the queue. Recommended: 1000 to 3000 ms.",
            lockTtlSeconds: "How long a job lock stays valid. Recommended: longer than normal file processing time, commonly 900 seconds.",
            heartbeatIntervalMs: "How often a running job refreshes its heartbeat. Recommended: 10000 to 30000 ms.",
            jobMaxAttempts: "Maximum attempts before a job moves to dead letter. Recommended: 3.",
            jobRetryDelayMs: "Delay before retrying a failed job. Recommended: 30000 to 120000 ms.",
            queueBackpressureLimit: "Global queued job limit. Recommended: 5000 to 20000 on larger servers.",
            queueBackpressureKnowledgeBaseLimit: "Queued job limit for one knowledge base. Recommended: lower than the global limit.",
            queueBackpressureMaxAgeSeconds: "Oldest accepted queue age before uploads slow down. Recommended: 3600 to 7200 seconds.",
            queueBackpressureRetryAfterSeconds: "Suggested wait time after backpressure. Recommended: 30 to 300 seconds.",
            shutdownGraceMs: "Time allowed for worker shutdown. Recommended: 30000 to 120000 ms.",
            completedJobRetentionDays: "Days to keep completed job records. Recommended: 7 to 30.",
            failedJobRetentionDays: "Days to keep failed job records. Recommended: 30 or longer.",
            deadLetterJobRetentionDays: "Days to keep dead-letter records. Recommended: 90.",
            retentionCleanupBatchSize: "Rows removed in each cleanup pass. Recommended: 500 to 2000."
          },
          publication: {
            mode: "Publication strategy. Recommended: batch for large knowledge bases, per file for fast visibility, manual for controlled release.",
            batchSize: "Files included in one publication job. Recommended: 100 to 500.",
            intervalSeconds: "Minimum interval between batch publications. Recommended: 120 to 600 seconds.",
            indexShardSize: "Entries per search index shard. Recommended: 1000 to 5000.",
            linkIndexShardSize: "Entries per link index shard. Recommended: 1000 to 5000.",
            manifestShardSize: "Entries per manifest shard. Recommended: 1000 to 5000.",
            graphEdgeShardSize: "Graph edges per shard. Recommended: 5000 to 20000.",
            graphCandidateLimit: "Candidate files considered for relationships. Recommended: 100 to 300.",
            graphMaintenanceBatchSize: "Files refreshed in each graph maintenance pass. Recommended: 200 to 1000.",
            rootSummaryLimit: "Items shown in the root summary and index. Recommended: 200 to 1000.",
            okfLogMaxEntries: "Recent update entries kept in log.md. Recommended: 50 to 200.",
            okfLogMaxBytes: "Maximum generated log.md size. Recommended: 65536 or higher for active knowledge bases."
          },
          models: {
            displayName: "Admin-facing model name. Recommended: include provider and usage.",
            baseUrl: "OpenAI-compatible API base URL. Recommended: include /v1 when the provider requires it.",
            apiKey: "Provider API key. Recommended: use a scoped key and rotate it regularly.",
            modelName: "Model identifier sent to the provider. Recommended: match provider documentation exactly.",
            contextWindowTokens: "Model context window size. Recommended: set the real model context limit.",
            requestMaxTimeoutMs: "Maximum request time. Recommended: 600000 ms or higher for long documents.",
            requestIdleTimeoutMs: "Idle timeout while waiting for model output. Recommended: 120000 to 300000 ms.",
            suggestionConcurrency: "Parallel model suggestion requests. Recommended: 1 to 2 first, then increase after observing stability.",
            transientRetryDelayMs: "Delay before retrying transient model failures. Recommended: 60000 ms.",
            requestMinIntervalMs: "Minimum delay between model requests. Recommended: 0 for stable providers, 1000 to 5000 ms for strict rate limits."
          },
          uploadGeneration: {
            maxBytes: "Maximum total bytes accepted by one upload request. Recommended: 10485760 for 10 MB, or lower for small deployments.",
            maxFiles: "Maximum Markdown files accepted by one upload request. Recommended: 50 on an 8C/32G server.",
            generationBatchSize: "Batch size used by generation, graph, indexing, and publication work. Recommended: 100 on an 8C/32G server.",
            fileProcessingConcurrency: "Number of file processing operations inside one worker job. Recommended: 1 for stable large imports.",
            storageConcurrency: "Number of uploaded source files written to S3-compatible storage at the same time. Recommended: 4, or 6 when S3 is stable."
          }
        },
        rateLimitGroups: {
          adminLogin: "Admin login",
          adminApi: "Admin API",
          upload: "Upload",
          publicOpenApi: "Developer OpenAPI"
        },
        fields: {
          max: "Max requests",
          windowSeconds: "Window seconds",
          sourceFileConcurrency: "Source file concurrency",
          claimBatchSize: "Claim batch size",
          pollIntervalMs: "Poll interval ms",
          lockTtlSeconds: "Lock TTL seconds",
          heartbeatIntervalMs: "Heartbeat interval ms",
          jobMaxAttempts: "Job max attempts",
          jobRetryDelayMs: "Job retry delay ms",
          queueBackpressureLimit: "Global queue limit",
          queueBackpressureKnowledgeBaseLimit: "Knowledge base queue limit",
          queueBackpressureMaxAgeSeconds: "Queue max age seconds",
          queueBackpressureRetryAfterSeconds: "Retry after seconds",
          shutdownGraceMs: "Shutdown grace ms",
          completedJobRetentionDays: "Completed retention days",
          failedJobRetentionDays: "Failed retention days",
          deadLetterJobRetentionDays: "Dead-letter retention days",
          retentionCleanupBatchSize: "Retention cleanup batch size",
          mode: "Mode",
          batchSize: "Batch size",
          intervalSeconds: "Interval seconds",
          indexShardSize: "Index shard size",
          linkIndexShardSize: "Link index shard size",
          manifestShardSize: "Manifest shard size",
          graphEdgeShardSize: "Graph edge shard size",
          graphCandidateLimit: "Graph candidate limit",
          graphMaintenanceBatchSize: "Graph maintenance batch size",
          rootSummaryLimit: "Root summary limit",
          okfLogMaxEntries: "Log max entries",
          okfLogMaxBytes: "Log max bytes",
          maxBytes: "Max upload bytes",
          maxFiles: "Max upload files",
          generationBatchSize: "Generation batch size",
          fileProcessingConcurrency: "File processing concurrency",
          storageConcurrency: "Storage concurrency",
          displayName: "Display name",
          baseUrl: "Base URL",
          apiKey: "API key",
          modelName: "Model name",
          contextWindowTokens: "Context window tokens",
          requestMaxTimeoutMs: "Request max timeout ms",
          requestIdleTimeoutMs: "Request idle timeout ms",
          suggestionConcurrency: "Suggestion concurrency",
          transientRetryDelayMs: "Transient retry delay ms",
          requestMinIntervalMs: "Request min interval ms"
        },
        models: {
          title: "Models",
          description: "Model assistance is optional. When no model is active, uploads continue with deterministic generation.",
          add: "Add model",
          addDescription: "Create a model configuration and choose whether it becomes active.",
          create: "Create model",
          empty: "No models configured",
          active: "Active",
          activate: "Activate",
          pause: "Pause",
          resume: "Resume",
          deleteTitle: "Delete model",
          deleteDescription: "Delete {{name}}. Running model work blocks deletion until it finishes.",
          deleteConfirm: "Delete model",
          requiredHint: "Model fields are required when creating a model.",
          status: {
            active: "Available",
            paused: "Paused",
            deleted: "Deleted"
          },
          table: {
            name: "Name",
            model: "Model",
            key: "Key",
            status: "Status",
            actions: "Actions"
          }
        }
      },
      openapiKeys: {
        title: "OpenAPI keys",
        description: "Manage bearer keys for public OpenAPI reads.",
        createAction: "Create key",
        createDescription: "Create a bearer key for agents and integrations.",
        createSubmit: "Create",
        creating: "Creating",
        nameLabel: "Key name",
        oneTimeTitle: "Copy this key now",
        oneTimeDescription: "This full key is shown once. Copy it before closing this dialog.",
        oneTimeLabel: "OpenAPI key",
        empty: "No OpenAPI keys",
        neverUsed: "Never used",
        deleteAction: "Delete {{name}}",
        deleteTitle: "Delete OpenAPI key",
        deleteDescription: "Delete {{name}}. Requests using this key will stop working.",
        status: {
          active: "Active",
          revoked: "Revoked"
        },
        table: {
          name: "Name",
          fingerprint: "Key",
          status: "Status",
          createdAt: "Created",
          lastUsedAt: "Last used",
          actions: "Actions"
        }
      },
      detail: {
        back: "Back",
        toggleSidebar: "Toggle sidebar",
        resizeSidebar: "Resize sidebar",
        emptyFiles: "Generated files will appear after upload parsing finishes.",
        loadingFiles: "Loading generated files...",
        fileTreeSearchPlaceholder: "Search files and folders",
        clearFileTreeSearch: "Clear file tree search",
        fileTreeSearchNoResults: "No matching files or folders",
        fileTreeSearchLoadMore: "Load more search results",
        fileTreeSearchTooShort: "Enter at least 2 characters",
        fileTreeSearchFailed: "File tree search failed",
        noFileSelected: "No file selected",
        sourceFiles: "Source files",
        releases: "Releases",
        bundleFiles: "Bundle files",
        emptyList: "No records",
        releaseItem: "{{count}} files",
        releaseItem_plural: "{{count}} files"
      },
      tasks: {
        title: "File processing",
        description: "Review uploaded Markdown files and parsing status.",
        empty: "No files are processing yet",
        running: "File processing is running",
        runningShort: "Running",
        ended: "File processing ended",
        endedShort: "Ended",
        refresh: "Refresh",
        noError: "No error",
        notRecorded: "Not recorded",
        filesTable: {
          status: "Status",
          fileName: "File name",
          fileId: "File ID",
          stage: "Current stage",
          model: "LLM",
          generatedFile: "Generated file",
          startedAt: "Started",
          endedAt: "Ended",
          error: "Error",
          actions: "Actions"
        },
        filters: {
          activeCount: "{{count}} active filter",
          activeCount_plural: "{{count}} active filters",
          all: "All",
          clear: "Clear",
          clearAll: "Clear filters",
          filterColumn: "Filter {{column}}",
          from: "From",
          to: "To",
          noMatches: "No files match the current filters",
          errorCode: "Error code",
          errorState: {
            with_error: "With error",
            without_error: "Without error"
          },
          actionState: {
            openable: "Openable",
            retryable: "Retryable",
            none: "No action"
          }
        },
        retryFile: "Retry parsing",
        retryingFile: "Retrying",
        openGeneratedFile: "Open file",
        noAction: "No action",
        deleteSelected: "Delete selected",
        selection: {
          currentPageOnly: "Selection applies to the current page only.",
          selectedCount: "{{count}} selected",
          selectCurrentPage: "Select eligible rows on this page",
          selectRow: "Select {{name}}"
        },
        deleteDialog: {
          title: "Delete processing tasks",
          description: "Delete {{count}} selected processing task. Published generated files stay available.",
          description_plural: "Delete {{count}} selected processing tasks. Published generated files stay available.",
          confirm: "Delete tasks",
          deleting: "Deleting"
        },
        deleteToast: {
          successTitle: "Tasks deleted",
          successDescription: "{{count}} task row was removed from the list.",
          successDescription_plural: "{{count}} task rows were removed from the list.",
          partialTitle: "Some tasks were skipped",
          partialDescription: "{{changed}} task row changed. {{skipped}} row was skipped because its state changed.",
          partialDescription_plural: "{{changed}} task rows changed. {{skipped}} rows were skipped because their state changed.",
          skippedTitle: "No tasks deleted",
          skippedDescription: "{{count}} selected row was not eligible.",
          skippedDescription_plural: "{{count}} selected rows were not eligible.",
          failedTitle: "Task deletion failed",
          networkFailure: "Network request failed"
        },
        generatedFile: {
          available: "Available",
          pending: "Pending",
          unavailable: "Unavailable"
        },
        fileStatus: {
          queued: "Queued",
          pending: "Queued",
          running: "Running",
          completed: "Completed",
          failed: "Failed"
        },
        phase: {
          uploadStorage: "Upload storage",
          sourceDeletion: "Source deletion",
          metadataResolution: "Metadata resolution",
          llmSuggestion: "LLM suggestions",
          graphGeneration: "Graph generation",
          okfValidation: "OKF validation",
          bundleGeneration: "Bundle generation",
          indexPublication: "Index publication",
          releaseActivation: "Release activation"
        },
        modelStatus: {
          running: "Running",
          completed: "Completed",
          failed: "Failed",
          skipped: "Skipped"
        },
        modelWarnings: "{{count}} warning",
        modelWarnings_plural: "{{count}} warnings",
        summary: {
          sourceQueue: "Source queue",
          publicationQueue: "Publication queue",
          dirtyFiles: "Publication waiting",
          activeCount: "{{count}} active",
          dirtyCount: "{{count}} file",
          dirtyCount_plural: "{{count}} files",
          queued: "{{count}} queued",
          running: "{{count}} running",
          failed: "{{count}} failed",
          deadLetter: "{{count}} dead-letter",
          oldestQueuedAge: "oldest {{seconds}}s",
          oldestDirty: "oldest {{time}}",
          noDirtyFiles: "No files waiting"
        },
        operation: {
          upload: "Upload",
          delete_source: "Delete file",
          delete_knowledge_base: "Delete knowledge base"
        },
        severity: {
          info: "Info",
          warning: "Warning",
          error: "Error"
        }
      },
      upload: {
        title: "Markdown sources",
        description: "Upload cleaned Markdown files. Metadata is parsed from frontmatter after upload.",
        selectFiles: "Select Markdown files",
        chooseFiles: "Choose Markdown files",
        noFilesSelected: "No Markdown files selected",
        selectedFile: "{{count}} selected Markdown file",
        selectedFiles: "{{count}} selected Markdown files",
        selectedFiles_plural: "{{count}} selected Markdown files",
        totalSize: "Total size: {{size}}",
        clearSelection: "Clear selection",
        removeFile: "Remove {{name}}",
        hiddenFiles: "{{count}} more selected file",
        hiddenFiles_plural: "{{count}} more selected files",
        upload: "Upload",
        uploading: "Uploading",
        ready: "Upload ready",
        summary: "{{count}} Markdown file ready for generation",
        summary_plural: "{{count}} Markdown files ready for generation",
        markdownOnly: "Upload cleaned .md files only"
      },
      generation: {
        start: "Generate bundle",
        inProgress: "Generating",
        success: "Bundle generated",
        failure: "Generation failed",
        modelWarnings: "Model suggestions were skipped; deterministic generation continued",
        generatedCount: "{{count}} generated file",
        generatedCount_plural: "{{count}} generated files"
      },
      result: {
        title: "Generated files",
        preview: "Preview",
        fileTree: "File tree",
        copyFile: "Copy file URL",
        copyIndex: "Copy index URL",
        copySearch: "Copy search URL",
        copyLinks: "Copy links URL",
        copied: "URL copied"
      },
      errors: {
        uploadMarkdownOnly: "Upload cleaned .md files only",
        uploadFileCountLimit: "Too many files selected",
        uploadByteLimit: "Selected files exceed the upload limit",
        missingMetadata: "Required metadata is missing",
        invalidKnowledgeBase: "Knowledge base data is invalid",
        invalidMetadata: "Metadata is invalid",
        generationValidationFailed: "Generation validation failed",
        generationStorageFailed: "Storage publication failed",
        invalidGenerationRequest: "Generation request is invalid",
        noUploadFiles: "Select at least one Markdown file",
        duplicateUploadFileName: "Markdown file names must be unique",
        queueBackpressure: "Processing queue is busy. Try again later.",
        uploadFailed: "Upload request failed",
        deleteFailed: "Delete request failed",
        fileNotDeletable: "This file cannot be deleted",
        sourceFileTaskDeletionInvalid: "Task deletion request is invalid",
        sourceFileTaskDeletionFailed: "Task deletion request failed",
        sourceFileRetryNotAllowed: "Only failed files can be retried",
        securityRequestRejected: "Request rejected",
        rateLimited: "Too many requests",
        openapiKeyFailed: "OpenAPI key request failed",
        runtimeSettingsUnavailable: "Runtime settings are unavailable",
        runtimeSettingsValidationFailed: "Runtime settings are invalid"
      }
    }
  },
  "zh-CN": {
    translation: {
      app: {
        name: "Focowiki"
      },
      language: {
        switchLabel: "语言",
        english: "English",
        chinese: "中文"
      },
      auth: {
        title: "管理端访问",
        description: "输入部署管理员账号和密码以管理 Markdown 知识包生成。",
        usernameLabel: "账号",
        usernamePlaceholder: "输入账号",
        passwordLabel: "密码",
        passwordPlaceholder: "输入密码",
        login: "登录",
        loggingIn: "登录中",
        logout: "退出登录",
        sessionReady: "管理端会话已就绪",
        invalidCredentials: "管理员账号或密码无效"
      },
      common: {
        cancel: "取消",
        close: "关闭",
        copy: "复制",
        copied: "已复制"
      },
      pagination: {
        label: "分页",
        currentPage: "第 {{page}} 页",
        next: "下一页",
        previous: "上一页",
        loading: "正在加载页面",
        expired: "当前分页已过期，请重新加载第一页。"
      },
      delete: {
        action: "删除",
        confirm: "删除",
        deleting: "删除中",
        knowledgeBaseMenu: "{{name}} 的知识库操作",
        knowledgeBaseTitle: "删除知识库",
        knowledgeBaseDescription: "从管理后台删除 {{name}}。",
        fileMenu: "文件操作",
        fileTitle: "删除 Markdown 文件",
        fileDescription: "删除 {{name}} 并重新发布知识库。"
      },
      home: {
        title: "知识库",
        knowledgeBasesTab: "知识库",
        openapiKeysTab: "OpenAPI keys",
        cardsTitle: "知识库",
        cardsDescription: "创建和打开 Markdown 知识库。",
        createAction: "创建知识库",
        createDescription: "创建知识库后再上传 Markdown 来源文件。",
        createSubmit: "创建",
        creating: "创建中",
        emptyTitle: "暂无知识库",
        emptyDescription: "创建第一个知识库后开始上传 Markdown 来源文件。",
        loading: "加载中",
        loadMore: "加载更多",
        searchLabel: "搜索知识库",
        searchPlaceholder: "搜索名称、描述或 ID",
        clearSearch: "清除搜索",
        searchEmptyTitle: "没有匹配的知识库",
        searchEmptyDescription: "可以尝试其他名称、描述或知识库 ID。",
        nameLabel: "知识库名称",
        descriptionLabel: "描述",
        noDescription: "暂无描述",
        knowledgeBaseIdLabel: "知识库 ID",
        copyKnowledgeBaseId: "复制知识库 ID {{id}}"
      },
      settings: {
        open: "打开设置",
        title: "设置",
        loading: "正在加载设置",
        save: "保存",
        saving: "保存中",
        tabs: {
          rateLimits: "API 限流",
          worker: "Worker",
          publication: "发布",
          uploadGeneration: "上传与生成",
          models: "模型"
        },
        rateLimits: {
          title: "API 限流",
          description: "实时调整 Admin 和 OpenAPI 请求限制，无需重启服务。"
        },
        worker: {
          title: "Worker",
          description: "调整队列处理、反压、重试和保留策略。"
        },
        publication: {
          title: "发布",
          description: "调整生成知识库发布和索引分片参数。"
        },
        uploadGeneration: {
          title: "上传与生成",
          description: "调整上传请求限制、S3 存储并发和生成批次大小。"
        },
        publicationModes: {
          batch: "批量",
          manual: "手动",
          per_file: "按文件"
        },
        toast: {
          saveSuccess: "设置已保存",
          saveFailed: "设置保存失败",
          modelCreated: "模型已创建",
          modelUpdated: "模型已更新",
          modelDeleted: "模型已删除",
          modelActionFailed: "模型操作失败"
        },
        validation: {
          requiredPositiveInteger: "必填数字字段必须为正整数。"
        },
        tips: {
          title: "Tips",
          rateLimits: {
            adminLogin: {
              maxLabel: "管理员登录 / 最大请求数",
              maxDescription: "一个计数窗口内允许的管理员登录尝试次数上限。推荐值 8，公网部署可使用 5 到 10。",
              windowSecondsLabel: "管理员登录 / 窗口秒数",
              windowSecondsDescription: "管理员登录尝试次数的计数窗口长度。推荐值 900 秒。",
            },
            adminApi: {
              maxLabel: "Admin API / 最大请求数",
              maxDescription: "一个计数窗口内允许的 Admin UI API 请求次数上限。推荐值 600。",
              windowSecondsLabel: "Admin API / 窗口秒数",
              windowSecondsDescription: "Admin UI API 请求次数的计数窗口长度。推荐值 60 秒。"
            },
            upload: {
              maxLabel: "上传 / 最大请求数",
              maxDescription: "一个计数窗口内允许的 Markdown 上传请求次数上限。推荐值 20。",
              windowSecondsLabel: "上传 / 窗口秒数",
              windowSecondsDescription: "Markdown 上传请求次数的计数窗口长度。推荐值 3600 秒。"
            },
            publicOpenApi: {
              maxLabel: "Developer OpenAPI / 最大请求数",
              maxDescription: "一个计数窗口内允许的 Developer OpenAPI 请求次数上限。推荐值 1200，再按服务器容量和真实流量调整。",
              windowSecondsLabel: "Developer OpenAPI / 窗口秒数",
              windowSecondsDescription: "Developer OpenAPI 请求次数的计数窗口长度。推荐值 60 秒。"
            }
          },
          worker: {
            sourceFileConcurrency: "同时处理的来源文件数量。8C/32G 服务器推荐 2 到 4。",
            claimBatchSize: "每轮领取的任务数量。推荐 10 到 50，并接近实际并发。",
            pollIntervalMs: "Worker 检查队列的间隔。推荐 1000 到 3000 毫秒。",
            lockTtlSeconds: "任务锁的有效时间。推荐长于单文件正常处理时间，常用 900 秒。",
            heartbeatIntervalMs: "运行中任务刷新心跳的间隔。推荐 10000 到 30000 毫秒。",
            jobMaxAttempts: "任务进入死信前的最大尝试次数。推荐 3 次。",
            jobRetryDelayMs: "失败任务再次重试前的等待时间。推荐 30000 到 120000 毫秒。",
            queueBackpressureLimit: "全局排队任务上限。大服务器推荐 5000 到 20000。",
            queueBackpressureKnowledgeBaseLimit: "单个知识库的排队任务上限。推荐低于全局上限。",
            queueBackpressureMaxAgeSeconds: "最早排队任务超过该时长后放慢上传。推荐 3600 到 7200 秒。",
            queueBackpressureRetryAfterSeconds: "反压触发后的建议等待时间。推荐 30 到 300 秒。",
            shutdownGraceMs: "Worker 关闭时允许任务收尾的时间。推荐 30000 到 120000 毫秒。",
            completedJobRetentionDays: "完成任务记录保留天数。推荐 7 到 30 天。",
            failedJobRetentionDays: "失败任务记录保留天数。推荐 30 天或更长。",
            deadLetterJobRetentionDays: "死信任务记录保留天数。推荐 90 天。",
            retentionCleanupBatchSize: "每次清理任务记录的行数。推荐 500 到 2000。"
          },
          publication: {
            mode: "发布策略。大知识库推荐批量，需要快速可见用按文件，需要人工控制用手动。",
            batchSize: "单次发布任务包含的文件数量。推荐 100 到 500。",
            intervalSeconds: "批量发布之间的最小间隔。推荐 120 到 600 秒。",
            indexShardSize: "搜索索引每个分片的条目数。推荐 1000 到 5000。",
            linkIndexShardSize: "链接索引每个分片的条目数。推荐 1000 到 5000。",
            manifestShardSize: "Manifest 每个分片的条目数。推荐 1000 到 5000。",
            graphEdgeShardSize: "图关系边每个分片的数量。推荐 5000 到 20000。",
            graphCandidateLimit: "生成关系时参与候选的文件数量。推荐 100 到 300。",
            graphMaintenanceBatchSize: "每轮图关系维护刷新的文件数量。推荐 200 到 1000。",
            rootSummaryLimit: "根目录摘要和索引展示的条目上限。推荐 200 到 1000。",
            okfLogMaxEntries: "log.md 保留的最近更新条数。推荐 50 到 200。",
            okfLogMaxBytes: "生成的 log.md 最大字节数。活跃知识库推荐 65536 或更高。"
          },
          models: {
            displayName: "管理后台展示的模型名称。推荐写清提供商和用途。",
            baseUrl: "OpenAI 兼容 API 地址。服务商要求时推荐包含 /v1。",
            apiKey: "模型服务 API key。推荐使用独立权限 key，并定期轮换。",
            modelName: "发送给模型服务的模型标识。推荐与服务商文档完全一致。",
            contextWindowTokens: "模型上下文窗口长度。推荐填写模型真实上下文上限。",
            requestMaxTimeoutMs: "单次请求最大等待时间。长文档推荐 600000 毫秒或更高。",
            requestIdleTimeoutMs: "等待模型输出时的空闲超时。推荐 120000 到 300000 毫秒。",
            suggestionConcurrency: "模型建议生成的并行请求数。推荐先用 1 到 2，稳定后再调高。",
            transientRetryDelayMs: "临时失败后的重试等待时间。推荐 60000 毫秒。",
            requestMinIntervalMs: "模型请求之间的最小间隔。稳定服务商可用 0，限流严格时推荐 1000 到 5000 毫秒。"
          },
          uploadGeneration: {
            maxBytes: "单次上传请求允许的总字节数上限。推荐值 10485760，即 10 MB；小型部署可降低。",
            maxFiles: "单次上传请求允许的 Markdown 文件数量上限。8C/32G 服务器推荐值 50。",
            generationBatchSize: "生成、图关系、索引和发布工作每批处理的数据量。8C/32G 服务器推荐值 100。",
            fileProcessingConcurrency: "单个 worker job 内部的文件处理并发数。大规模导入推荐值 1，更稳定。",
            storageConcurrency: "上传源文件同时写入 S3 兼容存储的数量。推荐值 4，S3 稳定时可使用 6。"
          }
        },
        rateLimitGroups: {
          adminLogin: "管理员登录",
          adminApi: "Admin API",
          upload: "上传",
          publicOpenApi: "Developer OpenAPI"
        },
        fields: {
          max: "最大请求数",
          windowSeconds: "窗口秒数",
          sourceFileConcurrency: "来源文件并发",
          claimBatchSize: "领取批次大小",
          pollIntervalMs: "轮询间隔毫秒",
          lockTtlSeconds: "锁 TTL 秒数",
          heartbeatIntervalMs: "心跳间隔毫秒",
          jobMaxAttempts: "任务最大尝试次数",
          jobRetryDelayMs: "任务重试延迟毫秒",
          queueBackpressureLimit: "全局队列上限",
          queueBackpressureKnowledgeBaseLimit: "知识库队列上限",
          queueBackpressureMaxAgeSeconds: "队列最大等待秒数",
          queueBackpressureRetryAfterSeconds: "重试等待秒数",
          shutdownGraceMs: "关闭等待毫秒",
          completedJobRetentionDays: "完成任务保留天数",
          failedJobRetentionDays: "失败任务保留天数",
          deadLetterJobRetentionDays: "死信任务保留天数",
          retentionCleanupBatchSize: "保留清理批次大小",
          mode: "模式",
          batchSize: "批次大小",
          intervalSeconds: "间隔秒数",
          indexShardSize: "索引分片大小",
          linkIndexShardSize: "链接索引分片大小",
          manifestShardSize: "Manifest 分片大小",
          graphEdgeShardSize: "图边分片大小",
          graphCandidateLimit: "图候选上限",
          graphMaintenanceBatchSize: "图维护批次大小",
          rootSummaryLimit: "根摘要上限",
          okfLogMaxEntries: "日志最大条数",
          okfLogMaxBytes: "日志最大字节数",
          maxBytes: "最大上传字节数",
          maxFiles: "最大上传文件数",
          generationBatchSize: "生成批次大小",
          fileProcessingConcurrency: "文件处理并发",
          storageConcurrency: "存储并发",
          displayName: "显示名称",
          baseUrl: "Base URL",
          apiKey: "API key",
          modelName: "模型名称",
          contextWindowTokens: "上下文窗口 tokens",
          requestMaxTimeoutMs: "请求最大超时毫秒",
          requestIdleTimeoutMs: "请求空闲超时毫秒",
          suggestionConcurrency: "建议生成并发",
          transientRetryDelayMs: "临时错误重试延迟毫秒",
          requestMinIntervalMs: "请求最小间隔毫秒"
        },
        models: {
          title: "模型",
          description: "模型辅助是可选能力。没有生效模型时，上传会继续执行确定性生成。",
          add: "添加模型",
          addDescription: "创建模型配置，并选择是否立即生效。",
          create: "创建模型",
          empty: "暂无模型配置",
          active: "生效中",
          activate: "设为生效",
          pause: "暂停",
          resume: "恢复",
          deleteTitle: "删除模型",
          deleteDescription: "删除 {{name}}。如果该模型仍有关联的运行中任务，系统会阻止删除。",
          deleteConfirm: "删除模型",
          requiredHint: "创建模型时，模型字段为必填。",
          status: {
            active: "可用",
            paused: "已暂停",
            deleted: "已删除"
          },
          table: {
            name: "名称",
            model: "模型",
            key: "Key",
            status: "状态",
            actions: "操作"
          }
        }
      },
      openapiKeys: {
        title: "OpenAPI keys",
        description: "管理公开 OpenAPI 读取使用的 Bearer key。",
        createAction: "创建 key",
        createDescription: "为 Agent 和集成创建 Bearer key。",
        createSubmit: "创建",
        creating: "创建中",
        nameLabel: "Key 名称",
        oneTimeTitle: "现在复制这个 key",
        oneTimeDescription: "完整 key 只显示一次，关闭弹窗前请先复制。",
        oneTimeLabel: "OpenAPI key",
        empty: "暂无 OpenAPI keys",
        neverUsed: "从未使用",
        deleteAction: "删除 {{name}}",
        deleteTitle: "删除 OpenAPI key",
        deleteDescription: "删除 {{name}}，使用该 key 的请求将停止工作。",
        status: {
          active: "启用",
          revoked: "已删除"
        },
        table: {
          name: "名称",
          fingerprint: "Key",
          status: "状态",
          createdAt: "创建时间",
          lastUsedAt: "最近使用",
          actions: "操作"
        }
      },
      detail: {
        back: "返回",
        toggleSidebar: "切换侧边栏",
        resizeSidebar: "调整侧边栏宽度",
        emptyFiles: "上传解析完成后会显示生成文件。",
        loadingFiles: "正在加载生成文件...",
        fileTreeSearchPlaceholder: "搜索文件和文件夹",
        clearFileTreeSearch: "清除文件树搜索",
        fileTreeSearchNoResults: "没有匹配的文件或文件夹",
        fileTreeSearchLoadMore: "加载更多搜索结果",
        fileTreeSearchTooShort: "至少输入 2 个字符",
        fileTreeSearchFailed: "文件树搜索失败",
        noFileSelected: "尚未选择文件",
        sourceFiles: "来源文件",
        releases: "发布版本",
        bundleFiles: "知识包文件",
        emptyList: "暂无记录",
        releaseItem: "{{count}} 个文件",
        releaseItem_plural: "{{count}} 个文件"
      },
      tasks: {
        title: "文件处理",
        description: "查看已上传 Markdown 文件和解析状态。",
        empty: "暂无处理文件",
        running: "文件处理中",
        runningShort: "运行中",
        ended: "文件处理已结束",
        endedShort: "已结束",
        refresh: "刷新",
        noError: "无错误",
        notRecorded: "未记录",
        filesTable: {
          status: "状态",
          fileName: "文件名",
          fileId: "文件 ID",
          stage: "当前阶段",
          model: "LLM",
          generatedFile: "生成文件",
          startedAt: "开始时间",
          endedAt: "结束时间",
          error: "错误",
          actions: "操作"
        },
        filters: {
          activeCount: "{{count}} 个筛选条件",
          activeCount_plural: "{{count}} 个筛选条件",
          all: "全部",
          clear: "清除",
          clearAll: "清除筛选",
          filterColumn: "筛选 {{column}}",
          from: "从",
          to: "到",
          noMatches: "没有符合当前筛选条件的文件",
          errorCode: "错误码",
          errorState: {
            with_error: "有错误",
            without_error: "无错误"
          },
          actionState: {
            openable: "可打开",
            retryable: "可重试",
            none: "无操作"
          }
        },
        retryFile: "重新解析",
        retryingFile: "解析中",
        openGeneratedFile: "打开文件",
        noAction: "无操作",
        deleteSelected: "删除所选任务",
        selection: {
          currentPageOnly: "仅选择当前页数据。",
          selectedCount: "已选择 {{count}} 项",
          selectCurrentPage: "选择当前页可删除行",
          selectRow: "选择 {{name}}"
        },
        deleteDialog: {
          title: "删除处理任务",
          description: "删除已选择的 {{count}} 个处理任务。已发布的生成文件仍可访问。",
          description_plural: "删除已选择的 {{count}} 个处理任务。已发布的生成文件仍可访问。",
          confirm: "删除任务",
          deleting: "删除中"
        },
        deleteToast: {
          successTitle: "任务已删除",
          successDescription: "已从列表移除 {{count}} 个任务行。",
          successDescription_plural: "已从列表移除 {{count}} 个任务行。",
          partialTitle: "部分任务已跳过",
          partialDescription: "{{changed}} 个任务行已变更，{{skipped}} 个任务行因状态变化被跳过。",
          partialDescription_plural: "{{changed}} 个任务行已变更，{{skipped}} 个任务行因状态变化被跳过。",
          skippedTitle: "没有删除任务",
          skippedDescription: "{{count}} 个所选任务当前不可删除。",
          skippedDescription_plural: "{{count}} 个所选任务当前不可删除。",
          failedTitle: "任务删除失败",
          networkFailure: "网络请求失败"
        },
        generatedFile: {
          available: "可用",
          pending: "待生成",
          unavailable: "不可用"
        },
        fileStatus: {
          queued: "排队中",
          pending: "排队中",
          running: "运行中",
          completed: "已完成",
          failed: "失败"
        },
        phase: {
          uploadStorage: "上传存储",
          sourceDeletion: "来源文件删除",
          metadataResolution: "元数据解析",
          llmSuggestion: "LLM 建议",
          graphGeneration: "图关系生成",
          okfValidation: "OKF 校验",
          bundleGeneration: "知识包生成",
          indexPublication: "索引发布",
          releaseActivation: "发布激活"
        },
        modelStatus: {
          running: "运行中",
          completed: "已完成",
          failed: "失败",
          skipped: "已跳过"
        },
        modelWarnings: "{{count}} 个警告",
        modelWarnings_plural: "{{count}} 个警告",
        summary: {
          sourceQueue: "来源队列",
          publicationQueue: "发布队列",
          dirtyFiles: "等待发布",
          activeCount: "{{count}} 个活跃",
          dirtyCount: "{{count}} 个文件",
          dirtyCount_plural: "{{count}} 个文件",
          queued: "{{count}} 个排队",
          running: "{{count}} 个运行中",
          failed: "{{count}} 个失败",
          deadLetter: "{{count}} 个死信",
          oldestQueuedAge: "最早 {{seconds}} 秒",
          oldestDirty: "最早 {{time}}",
          noDirtyFiles: "暂无等待发布文件"
        },
        operation: {
          upload: "上传",
          delete_source: "删除文件",
          delete_knowledge_base: "删除知识库"
        },
        severity: {
          info: "信息",
          warning: "警告",
          error: "错误"
        }
      },
      upload: {
        title: "Markdown 来源文件",
        description: "上传清洗后的 Markdown 文件，系统会在上传后解析 frontmatter 元数据。",
        selectFiles: "选择 Markdown 文件",
        chooseFiles: "选择 Markdown 文件",
        noFilesSelected: "尚未选择 Markdown 文件",
        selectedFile: "已选择 {{count}} 个 Markdown 文件",
        selectedFiles: "已选择 {{count}} 个 Markdown 文件",
        selectedFiles_plural: "已选择 {{count}} 个 Markdown 文件",
        totalSize: "总大小：{{size}}",
        clearSelection: "清空选择",
        removeFile: "移除 {{name}}",
        hiddenFiles: "还有 {{count}} 个已选文件",
        hiddenFiles_plural: "还有 {{count}} 个已选文件",
        upload: "上传",
        uploading: "上传中",
        ready: "上传已就绪",
        summary: "{{count}} 个 Markdown 文件可用于生成",
        summary_plural: "{{count}} 个 Markdown 文件可用于生成",
        markdownOnly: "仅上传清洗后的 .md 文件"
      },
      generation: {
        start: "生成知识包",
        inProgress: "生成中",
        success: "知识包已生成",
        failure: "生成失败",
        modelWarnings: "模型建议已跳过，系统已继续确定性生成",
        generatedCount: "已生成 {{count}} 个文件",
        generatedCount_plural: "已生成 {{count}} 个文件"
      },
      result: {
        title: "生成文件",
        preview: "预览",
        fileTree: "文件树",
        copyFile: "复制文件 URL",
        copyIndex: "复制 index URL",
        copySearch: "复制 search URL",
        copyLinks: "复制 links URL",
        copied: "URL 已复制"
      },
      errors: {
        uploadMarkdownOnly: "仅上传清洗后的 .md 文件",
        uploadFileCountLimit: "选择的文件数量过多",
        uploadByteLimit: "选择的文件超过上传限制",
        missingMetadata: "缺少必填元数据",
        invalidKnowledgeBase: "知识库数据无效",
        invalidMetadata: "元数据无效",
        generationValidationFailed: "生成校验失败",
        generationStorageFailed: "存储发布失败",
        invalidGenerationRequest: "生成请求无效",
        noUploadFiles: "请至少选择一个 Markdown 文件",
        duplicateUploadFileName: "Markdown 文件名不能重复",
        queueBackpressure: "处理队列繁忙，请稍后重试",
        uploadFailed: "上传请求失败",
        deleteFailed: "删除请求失败",
        fileNotDeletable: "该文件不能删除",
        sourceFileTaskDeletionInvalid: "任务删除请求无效",
        sourceFileTaskDeletionFailed: "任务删除请求失败",
        sourceFileRetryNotAllowed: "只有失败文件可以重新解析",
        securityRequestRejected: "请求已被拒绝",
        rateLimited: "请求过于频繁",
        openapiKeyFailed: "OpenAPI key 请求失败",
        runtimeSettingsUnavailable: "运行时设置不可用",
        runtimeSettingsValidationFailed: "运行时设置无效"
      }
    }
  }
} as const;

export function resolveLocale(language: string | undefined, fallback = DEFAULT_LOCALE): SupportedLocale {
  if (isSupportedLocale(language)) {
    return language;
  }

  const languagePrefix = language?.toLowerCase().split("-")[0];
  if (languagePrefix === "en") {
    return "en-US";
  }
  if (languagePrefix === "zh") {
    return "zh-CN";
  }

  return fallback;
}

function isSupportedLocale(language: string | undefined): language is SupportedLocale {
  return SUPPORTED_LOCALES.some((locale) => locale === language);
}
