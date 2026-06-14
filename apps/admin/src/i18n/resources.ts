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
        cancel: "Cancel"
      },
      home: {
        title: "Knowledge bases",
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
        nameLabel: "Knowledge base name",
        descriptionLabel: "Description",
        noDescription: "No description"
      },
      detail: {
        back: "Back",
        toggleSidebar: "Toggle sidebar",
        tasks: "Tasks",
        emptyFiles: "Generated files will appear after upload parsing finishes.",
        noFileSelected: "No file selected",
        sourceFiles: "Source files",
        releases: "Releases",
        bundleFiles: "Bundle files",
        emptyList: "No records",
        releaseItem: "{{count}} files",
        releaseItem_plural: "{{count}} files"
      },
      tasks: {
        title: "Upload tasks",
        description: "Review upload parsing lifecycle and internal phase details.",
        empty: "No upload tasks yet",
        item: "Upload task {{id}}",
        running: "Upload parsing task is running",
        runningShort: "Running",
        ended: "Upload parsing task ended",
        endedShort: "Ended",
        emptyPhases: "No internal phases",
        moreFiles: "+ {{count}} more",
        notRecorded: "Not recorded",
        table: {
          status: "Status",
          fileName: "File name",
          taskId: "Task ID",
          detail: "Detail",
          startedAt: "Started",
          endedAt: "Ended"
        },
        phase: {
          uploadStorage: "Upload storage",
          metadataResolution: "Metadata resolution",
          okfValidation: "OKF validation",
          bundleGeneration: "Bundle generation",
          indexPublication: "Index publication",
          releaseActivation: "Release activation"
        },
        severity: {
          info: "Info",
          warning: "Warning",
          error: "Error"
        }
      },
      upload: {
        title: "Markdown sources",
        description: "Upload cleaned Markdown files and optional default metadata.",
        selectFiles: "Select Markdown files",
        chooseFiles: "Choose Markdown files",
        noFilesSelected: "No Markdown files selected",
        selectedFiles: "{{count}} selected Markdown file",
        selectedFiles_plural: "{{count}} selected Markdown files",
        defaultType: "Default type",
        defaultTitle: "Default title",
        defaultDescription: "Default description",
        defaultTags: "Default tags",
        upload: "Upload",
        uploading: "Uploading",
        ready: "Upload ready",
        summary: "{{count}} Markdown file ready for generation",
        summary_plural: "{{count}} Markdown files ready for generation",
        markdownOnly: "Upload cleaned .md files only",
        missingMetadata: "Add type and title metadata before generation"
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
        uploadFailed: "Upload request failed"
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
        cancel: "取消"
      },
      home: {
        title: "知识库",
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
        nameLabel: "知识库名称",
        descriptionLabel: "描述",
        noDescription: "暂无描述"
      },
      detail: {
        back: "返回",
        toggleSidebar: "切换侧边栏",
        tasks: "任务",
        emptyFiles: "上传解析完成后会显示生成文件。",
        noFileSelected: "尚未选择文件",
        sourceFiles: "来源文件",
        releases: "发布版本",
        bundleFiles: "知识包文件",
        emptyList: "暂无记录",
        releaseItem: "{{count}} 个文件",
        releaseItem_plural: "{{count}} 个文件"
      },
      tasks: {
        title: "上传任务",
        description: "查看上传解析生命周期和内部阶段详情。",
        empty: "暂无上传任务",
        item: "上传任务 {{id}}",
        running: "上传解析任务运行中",
        runningShort: "运行中",
        ended: "上传解析任务已结束",
        endedShort: "已结束",
        emptyPhases: "暂无内部阶段",
        moreFiles: "+ {{count}} 个文件",
        notRecorded: "未记录",
        table: {
          status: "状态",
          fileName: "文件名",
          taskId: "任务 ID",
          detail: "详情",
          startedAt: "开始时间",
          endedAt: "结束时间"
        },
        phase: {
          uploadStorage: "上传存储",
          metadataResolution: "元数据解析",
          okfValidation: "OKF 校验",
          bundleGeneration: "知识包生成",
          indexPublication: "索引发布",
          releaseActivation: "发布激活"
        },
        severity: {
          info: "信息",
          warning: "警告",
          error: "错误"
        }
      },
      upload: {
        title: "Markdown 来源文件",
        description: "上传清洗后的 Markdown 文件，并可填写默认元数据。",
        selectFiles: "选择 Markdown 文件",
        chooseFiles: "选择 Markdown 文件",
        noFilesSelected: "尚未选择 Markdown 文件",
        selectedFiles: "已选择 {{count}} 个 Markdown 文件",
        selectedFiles_plural: "已选择 {{count}} 个 Markdown 文件",
        defaultType: "默认 type",
        defaultTitle: "默认 title",
        defaultDescription: "默认描述",
        defaultTags: "默认标签",
        upload: "上传",
        uploading: "上传中",
        ready: "上传已就绪",
        summary: "{{count}} 个 Markdown 文件可用于生成",
        summary_plural: "{{count}} 个 Markdown 文件可用于生成",
        markdownOnly: "仅上传清洗后的 .md 文件",
        missingMetadata: "生成前请补充 type 和 title 元数据"
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
        uploadFailed: "上传请求失败"
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
