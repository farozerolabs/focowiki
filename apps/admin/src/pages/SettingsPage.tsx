import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftIcon,
  CheckIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon
} from "lucide-react";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { Alert, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { showAdminToast } from "@/hooks/use-admin-toast";
import {
  activateRuntimeModel,
  createRuntimeModel,
  deleteRuntimeModel,
  fetchRuntimeSettings,
  pauseRuntimeModel,
  resumeRuntimeModel,
  updatePublicationSettings,
  updateRateLimitSettings,
  updateUploadGenerationSettings,
  updateWorkerSettings,
  type ApiFailure,
  type PublicationSettings,
  type RateLimitSettings,
  type RuntimeModelConfig,
  type RuntimeSettingsResponse,
  type UploadGenerationSettings,
  type WorkerSettings
} from "@/lib/admin-api";

type SettingsPageProps = {
  onBack: () => void;
  onLogout: () => void;
};

const rateLimitGroups = [
  "adminLogin",
  "adminApi",
  "upload",
  "publicOpenApi"
] as const satisfies readonly (keyof RateLimitSettings)[];

const workerNumberFields = [
  "sourceFileConcurrency",
  "claimBatchSize",
  "pollIntervalMs",
  "lockTtlSeconds",
  "heartbeatIntervalMs",
  "jobMaxAttempts",
  "jobRetryDelayMs",
  "queueBackpressureLimit",
  "queueBackpressureKnowledgeBaseLimit",
  "queueBackpressureMaxAgeSeconds",
  "queueBackpressureRetryAfterSeconds",
  "shutdownGraceMs",
  "completedJobRetentionDays",
  "failedJobRetentionDays",
  "deadLetterJobRetentionDays",
  "retentionCleanupBatchSize",
  "hardDeleteConcurrency",
  "hardDeleteDatabaseBatchSize",
  "hardDeleteObjectBatchSize",
  "hardDeleteMaxAttempts",
  "hardDeleteRetryDelayMs",
  "hardDeleteFailedRetentionDays"
] as const satisfies readonly (keyof Omit<WorkerSettings, "hardDeleteVersionPurgeEnabled">)[];

const workerBooleanFields = [
  "hardDeleteVersionPurgeEnabled"
] as const satisfies readonly (keyof Pick<WorkerSettings, "hardDeleteVersionPurgeEnabled">)[];

const publicationFields = [
  "batchSize",
  "intervalSeconds",
  "indexShardSize",
  "linkIndexShardSize",
  "manifestShardSize",
  "graphEdgeShardSize",
  "graphCandidateLimit",
  "graphMaintenanceBatchSize",
  "rootSummaryLimit",
  "okfLogMaxEntries",
  "okfLogMaxBytes"
] as const satisfies readonly (keyof Omit<PublicationSettings, "mode">)[];

const publicationModes = ["batch", "manual", "per_file"] as const satisfies readonly PublicationSettings["mode"][];

const uploadGenerationFields = [
  "maxBytes",
  "maxFiles",
  "generationBatchSize",
  "fileProcessingConcurrency",
  "storageConcurrency"
] as const satisfies readonly (keyof UploadGenerationSettings)[];

const modelApiModes = ["responses", "chat_completions"] as const satisfies readonly RuntimeModelConfig["apiMode"][];

const modelNumberFields = [
  "contextWindowTokens",
  "requestMaxTimeoutMs",
  "requestIdleTimeoutMs",
  "suggestionConcurrency",
  "transientRetryDelayMs",
  "requestMinIntervalMs"
] as const;

const rateLimitTipItems = rateLimitGroups.flatMap((group) => [
  {
    labelKey: `settings.tips.rateLimits.${group}.maxLabel`,
    descriptionKey: `settings.tips.rateLimits.${group}.maxDescription`
  },
  {
    labelKey: `settings.tips.rateLimits.${group}.windowSecondsLabel`,
    descriptionKey: `settings.tips.rateLimits.${group}.windowSecondsDescription`
  }
]);

const workerTipItems = [...workerNumberFields, ...workerBooleanFields].map((field) => ({
  labelKey: `settings.fields.${field}`,
  descriptionKey: `settings.tips.worker.${field}`
}));

const publicationTipItems = [
  {
    labelKey: "settings.fields.mode",
    descriptionKey: "settings.tips.publication.mode"
  },
  ...publicationFields.map((field) => ({
    labelKey: `settings.fields.${field}`,
    descriptionKey: `settings.tips.publication.${field}`
  }))
];

const uploadGenerationTipItems = uploadGenerationFields.map((field) => ({
  labelKey: `settings.fields.${field}`,
  descriptionKey: `settings.tips.uploadGeneration.${field}`
}));

const modelTipItems = [
  "displayName",
  "apiMode",
  "baseUrl",
  "apiKey",
  "modelName",
  ...modelNumberFields
].map((field) => ({
  labelKey: `settings.fields.${field}`,
  descriptionKey: `settings.tips.models.${field}`
}));

type EditableNumber = number | "";
type RateLimitGroup = (typeof rateLimitGroups)[number];
type WorkerNumberField = (typeof workerNumberFields)[number];
type PublicationField = (typeof publicationFields)[number];
type UploadGenerationField = (typeof uploadGenerationFields)[number];
type ModelApiMode = (typeof modelApiModes)[number];
type ModelNumberField = (typeof modelNumberFields)[number];

type EditableRateLimitSettings = Record<
  RateLimitGroup,
  {
    max: EditableNumber;
    windowSeconds: EditableNumber;
  }
>;
type EditableWorkerSettings = Record<WorkerNumberField, EditableNumber> &
  Pick<WorkerSettings, "hardDeleteVersionPurgeEnabled">;
type EditablePublicationSettings = {
  mode: PublicationSettings["mode"];
} & Record<PublicationField, EditableNumber>;
type EditableUploadGenerationSettings = Record<UploadGenerationField, EditableNumber>;
type EditableModelForm = {
  displayName: string;
  apiMode: ModelApiMode;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  isActive: boolean;
} & Record<ModelNumberField, EditableNumber>;

export function SettingsPage({ onBack, onLogout }: SettingsPageProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<RuntimeSettingsResponse | null>(null);
  const [rateLimits, setRateLimits] = useState<EditableRateLimitSettings | null>(null);
  const [worker, setWorker] = useState<EditableWorkerSettings | null>(null);
  const [publication, setPublication] = useState<EditablePublicationSettings | null>(null);
  const [uploadGeneration, setUploadGeneration] =
    useState<EditableUploadGenerationSettings | null>(null);
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState("");
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [deleteModelTarget, setDeleteModelTarget] = useState<RuntimeModelConfig | null>(null);
  const [modelForm, setModelForm] = useState(createEmptyModelForm);

  useEffect(() => {
    void loadSettings();
  }, []);

  async function loadSettings() {
    setError("");
    const result = await fetchRuntimeSettings();

    if ("messageKey" in result) {
      setError(result.messageKey);
      showAdminToast({
        title: t("settings.toast.saveFailed"),
        description: t(result.messageKey),
        variant: "destructive"
      });
      return;
    }

    applySettingsResponse(result);
  }

  async function handleRateLimitSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rateLimits) {
      return;
    }
    const payload = buildRateLimitSettings(rateLimits);
    if (!payload) {
      showNumberValidationError();
      return;
    }
    await saveSettings("rateLimits", () => updateRateLimitSettings(payload));
  }

  async function handleWorkerSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!worker) {
      return;
    }
    const payload = buildWorkerSettings(worker);
    if (!payload) {
      showNumberValidationError();
      return;
    }
    await saveSettings("worker", () => updateWorkerSettings(payload));
  }

  async function handlePublicationSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publication) {
      return;
    }
    const payload = buildPublicationSettings(publication);
    if (!payload) {
      showNumberValidationError();
      return;
    }
    await saveSettings("publication", () => updatePublicationSettings(payload));
  }

  async function handleUploadGenerationSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadGeneration) {
      return;
    }
    const payload = buildUploadGenerationSettings(uploadGeneration);
    if (!payload) {
      showNumberValidationError();
      return;
    }
    await saveSettings("uploadGeneration", () => updateUploadGenerationSettings(payload));
  }

  async function saveSettings(
    key: string,
    submit: () => Promise<{ settings: RuntimeSettingsResponse["settings"] } | ApiFailure>
  ) {
    setIsSaving(key);
    setError("");
    const result = await submit();
    setIsSaving("");

    if ("messageKey" in result) {
      setError(result.messageKey);
      return;
    }

    setData((current) => (current ? { ...current, settings: result.settings } : current));
    setRateLimits(toEditableRateLimits(result.settings.rateLimits));
    setWorker(toEditableWorkerSettings(result.settings.worker));
    setPublication(toEditablePublicationSettings(result.settings.publication));
    setUploadGeneration(toEditableUploadGenerationSettings(result.settings.uploadGeneration));
    showAdminToast({ title: t("settings.toast.saveSuccess") });
  }

  async function handleCreateModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = buildModelPayload(modelForm);
    if (!payload) {
      showNumberValidationError();
      return;
    }
    setIsSaving("model");
    setError("");
    const result = await createRuntimeModel(payload);
    setIsSaving("");

    if ("messageKey" in result) {
      setError(result.messageKey);
      showAdminToast({
        title: t("settings.toast.saveFailed"),
        description: t(result.messageKey),
        variant: "destructive"
      });
      return;
    }

    setIsModelDialogOpen(false);
    setModelForm(createEmptyModelForm());
    showAdminToast({ title: t("settings.toast.modelCreated") });
    await loadSettings();
  }

  function applySettingsResponse(result: RuntimeSettingsResponse) {
    setData(result);
    setRateLimits(toEditableRateLimits(result.settings.rateLimits));
    setWorker(toEditableWorkerSettings(result.settings.worker));
    setPublication(toEditablePublicationSettings(result.settings.publication));
    setUploadGeneration(toEditableUploadGenerationSettings(result.settings.uploadGeneration));
  }

  function showNumberValidationError() {
    const messageKey = "settings.validation.requiredPositiveInteger";
    setError(messageKey);
    showAdminToast({
      title: t("settings.toast.saveFailed"),
      description: t(messageKey),
      variant: "destructive"
    });
  }

  async function handleModelAction(
    action: () => Promise<{ model: RuntimeModelConfig } | ApiFailure>
  ) {
    setError("");
    const result = await action();

    if ("messageKey" in result) {
      setError(result.messageKey);
      showAdminToast({
        title: t("settings.toast.modelActionFailed"),
        description: t(result.messageKey),
        variant: "destructive"
      });
      return;
    }

    showAdminToast({ title: t("settings.toast.modelUpdated") });
    await loadSettings();
  }

  async function handleDeleteModel() {
    if (!deleteModelTarget) {
      return;
    }

    setIsSaving("model-delete");
    setError("");
    const result = await deleteRuntimeModel(deleteModelTarget.id);
    setIsSaving("");

    if ("messageKey" in result) {
      setError(result.messageKey);
      showAdminToast({
        title: t("settings.toast.modelActionFailed"),
        description: t(result.messageKey),
        variant: "destructive"
      });
      return;
    }

    setDeleteModelTarget(null);
    showAdminToast({ title: t("settings.toast.modelDeleted") });
    await loadSettings();
  }

  return (
    <main className="min-h-svh bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button type="button" variant="ghost" size="icon-sm" onClick={onBack}>
              <ArrowLeftIcon />
            </Button>
            <img src="/logo.jpg" alt="" className="size-10 rounded-md object-cover" />
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">{t("app.name")}</p>
              <h1 className="text-xl font-medium">{t("settings.title")}</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitch />
            <Button type="button" variant="outline" onClick={onLogout}>
              {t("auth.logout")}
            </Button>
          </div>
        </div>
      </header>
      <section className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{t(error)}</AlertTitle>
          </Alert>
        ) : null}
        {!data ? (
          <Alert>
            <AlertTitle>{t("settings.loading")}</AlertTitle>
          </Alert>
        ) : (
          <Tabs defaultValue="rate-limits">
            <TabsList>
              <TabsTrigger value="rate-limits">{t("settings.tabs.rateLimits")}</TabsTrigger>
              <TabsTrigger value="worker">{t("settings.tabs.worker")}</TabsTrigger>
              <TabsTrigger value="publication">{t("settings.tabs.publication")}</TabsTrigger>
              <TabsTrigger value="upload-generation">
                {t("settings.tabs.uploadGeneration")}
              </TabsTrigger>
              <TabsTrigger value="models">{t("settings.tabs.models")}</TabsTrigger>
            </TabsList>
            <TabsContent value="rate-limits">
              {rateLimits ? (
                <div className="space-y-3">
                  <SettingsCard
                    title={t("settings.rateLimits.title")}
                    description={t("settings.rateLimits.description")}
                  >
                    <form noValidate onSubmit={handleRateLimitSave}>
                      <FieldGroup>
                        <div className="grid gap-4 md:grid-cols-2">
                          {rateLimitGroups.map((group) => (
                            <Card key={group}>
                              <CardHeader>
                                <CardTitle className="text-sm">
                                  {t(`settings.rateLimitGroups.${group}`)}
                                </CardTitle>
                              </CardHeader>
                              <CardContent className="grid gap-3">
                                <NumberField
                                  id={`${group}-max`}
                                  label={t("settings.fields.max")}
                                  value={rateLimits[group].max}
                                  required
                                  onChange={(value) =>
                                    setRateLimits({
                                      ...rateLimits,
                                      [group]: { ...rateLimits[group], max: value }
                                    })
                                  }
                                />
                                <NumberField
                                  id={`${group}-windowSeconds`}
                                  label={t("settings.fields.windowSeconds")}
                                  value={rateLimits[group].windowSeconds}
                                  required
                                  onChange={(value) =>
                                    setRateLimits({
                                      ...rateLimits,
                                      [group]: { ...rateLimits[group], windowSeconds: value }
                                    })
                                  }
                                />
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                        <SaveButton isSaving={isSaving === "rateLimits"} />
                      </FieldGroup>
                    </form>
                  </SettingsCard>
                  <PlainTips items={rateLimitTipItems} />
                </div>
              ) : null}
            </TabsContent>
            <TabsContent value="worker">
              {worker ? (
                <div className="space-y-3">
                  <SettingsCard
                    title={t("settings.worker.title")}
                    description={t("settings.worker.description")}
                  >
                    <form noValidate onSubmit={handleWorkerSave}>
                      <FieldGroup>
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                          {workerNumberFields.map((field) => (
                            <NumberField
                              key={field}
                              id={`worker-${field}`}
                              label={t(`settings.fields.${field}`)}
                              value={worker[field]}
                              required
                              onChange={(value) => setWorker({ ...worker, [field]: value })}
                            />
                          ))}
                          <Field>
                            <FieldLabel htmlFor="worker-hardDeleteVersionPurgeEnabled">
                              <RequiredLabel
                                label={t("settings.fields.hardDeleteVersionPurgeEnabled")}
                                required
                              />
                            </FieldLabel>
                            <label className="flex min-h-9 items-center gap-2 rounded-md border border-input px-3 text-sm">
                              <Checkbox
                                id="worker-hardDeleteVersionPurgeEnabled"
                                checked={worker.hardDeleteVersionPurgeEnabled}
                                onCheckedChange={(checked) =>
                                  setWorker({
                                    ...worker,
                                    hardDeleteVersionPurgeEnabled: checked === true
                                  })
                                }
                              />
                              <span>{t("settings.fields.hardDeleteVersionPurgeEnabled")}</span>
                            </label>
                          </Field>
                        </div>
                        <SaveButton isSaving={isSaving === "worker"} />
                      </FieldGroup>
                    </form>
                  </SettingsCard>
                  <PlainTips items={workerTipItems} />
                </div>
              ) : null}
            </TabsContent>
            <TabsContent value="publication">
              {publication ? (
                <div className="space-y-3">
                  <SettingsCard
                    title={t("settings.publication.title")}
                    description={t("settings.publication.description")}
                  >
                    <form noValidate onSubmit={handlePublicationSave}>
                      <FieldGroup>
                        <Field>
                          <FieldLabel htmlFor="publication-mode">
                            <RequiredLabel label={t("settings.fields.mode")} required />
                          </FieldLabel>
                          <Select
                            value={publication.mode}
                            onValueChange={(value) =>
                              setPublication({
                                ...publication,
                                mode: value as PublicationSettings["mode"]
                              })
                            }
                          >
                            <SelectTrigger id="publication-mode">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {publicationModes.map((mode) => (
                                <SelectItem key={mode} value={mode}>
                                  {t(`settings.publicationModes.${mode}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                          {publicationFields.map((field) => (
                            <NumberField
                              key={field}
                              id={`publication-${field}`}
                              label={t(`settings.fields.${field}`)}
                              value={publication[field]}
                              required
                              onChange={(value) => setPublication({ ...publication, [field]: value })}
                            />
                          ))}
                        </div>
                        <SaveButton isSaving={isSaving === "publication"} />
                      </FieldGroup>
                    </form>
                  </SettingsCard>
                  <PlainTips items={publicationTipItems} />
                </div>
              ) : null}
            </TabsContent>
            <TabsContent value="upload-generation">
              <div className="space-y-3">
                <SettingsCard
                  title={t("settings.uploadGeneration.title")}
                  description={t("settings.uploadGeneration.description")}
                >
                  {uploadGeneration ? (
                    <form noValidate onSubmit={handleUploadGenerationSave}>
                      <FieldGroup>
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                          {uploadGenerationFields.map((field) => (
                            <NumberField
                              key={field}
                              id={`upload-generation-${field}`}
                              label={t(`settings.fields.${field}`)}
                              value={uploadGeneration[field]}
                              required
                              onChange={(value) =>
                                setUploadGeneration({ ...uploadGeneration, [field]: value })
                              }
                            />
                          ))}
                        </div>
                        <SaveButton isSaving={isSaving === "uploadGeneration"} />
                      </FieldGroup>
                    </form>
                  ) : null}
                </SettingsCard>
                <PlainTips items={uploadGenerationTipItems} />
              </div>
            </TabsContent>
            <TabsContent value="models">
              <div className="space-y-3">
                <SettingsCard
                  title={t("settings.models.title")}
                  description={t("settings.models.description")}
                  action={
                    <Button type="button" onClick={() => setIsModelDialogOpen(true)}>
                      <PlusIcon data-icon="inline-start" />
                      {t("settings.models.add")}
                    </Button>
                  }
                >
                  <Table className="min-w-[1280px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("settings.fields.displayName")}</TableHead>
                        <TableHead>{t("settings.fields.apiMode")}</TableHead>
                        <TableHead>{t("settings.fields.baseUrl")}</TableHead>
                        <TableHead>{t("settings.fields.apiKey")}</TableHead>
                        <TableHead>{t("settings.fields.modelName")}</TableHead>
                        {modelNumberFields.map((field) => (
                          <TableHead key={field}>{t(`settings.fields.${field}`)}</TableHead>
                        ))}
                        <TableHead>{t("settings.models.table.status")}</TableHead>
                        <TableHead>{t("settings.models.table.actions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.models.map((model) => (
                        <TableRow key={model.id}>
                          <TableCell>{model.displayName}</TableCell>
                          <TableCell>{t(`settings.modelApiModes.${model.apiMode}`)}</TableCell>
                          <TableCell>{model.baseUrl}</TableCell>
                          <TableCell>{model.apiKeyFingerprint}</TableCell>
                          <TableCell>{model.modelName}</TableCell>
                          {modelNumberFields.map((field) => (
                            <TableCell key={field}>{model[field]}</TableCell>
                          ))}
                          <TableCell>
                            {model.isActive ? t("settings.models.active") : t(`settings.models.status.${model.status}`)}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-2">
                              {!model.isActive && model.status === "active" ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    void handleModelAction(() => activateRuntimeModel(model.id))
                                  }
                                >
                                  <CheckIcon data-icon="inline-start" />
                                  {t("settings.models.activate")}
                                </Button>
                              ) : null}
                              {model.status === "active" ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    void handleModelAction(() => pauseRuntimeModel(model.id))
                                  }
                                >
                                  <PauseIcon data-icon="inline-start" />
                                  {t("settings.models.pause")}
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    void handleModelAction(() => resumeRuntimeModel(model.id))
                                  }
                                >
                                  <PlayIcon data-icon="inline-start" />
                                  {t("settings.models.resume")}
                                </Button>
                              )}
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                onClick={() => setDeleteModelTarget(model)}
                              >
                                <Trash2Icon data-icon="inline-start" />
                                {t("delete.action")}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {data.models.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("settings.models.empty")}</p>
                  ) : null}
                </SettingsCard>
                <PlainTips items={modelTipItems} />
              </div>
            </TabsContent>
          </Tabs>
        )}
      </section>
      <Dialog open={isModelDialogOpen} onOpenChange={setIsModelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.models.add")}</DialogTitle>
            <DialogDescription>{t("settings.models.addDescription")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateModel}>
            <FieldGroup>
              <TextField
                id="model-display-name"
                label={t("settings.fields.displayName")}
                value={modelForm.displayName}
                required
                onChange={(value) => setModelForm({ ...modelForm, displayName: value })}
              />
              <Field>
                <FieldLabel htmlFor="model-api-mode">
                  <RequiredLabel label={t("settings.fields.apiMode")} required />
                </FieldLabel>
                <Select
                  value={modelForm.apiMode}
                  onValueChange={(value) =>
                    setModelForm({ ...modelForm, apiMode: value as ModelApiMode })
                  }
                >
                  <SelectTrigger id="model-api-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelApiModes.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {t(`settings.modelApiModes.${mode}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <TextField
                id="model-base-url"
                label={t("settings.fields.baseUrl")}
                value={modelForm.baseUrl}
                required
                onChange={(value) => setModelForm({ ...modelForm, baseUrl: value })}
              />
              <TextField
                id="model-api-key"
                label={t("settings.fields.apiKey")}
                value={modelForm.apiKey}
                required
                onChange={(value) => setModelForm({ ...modelForm, apiKey: value })}
              />
              <TextField
                id="model-name"
                label={t("settings.fields.modelName")}
                value={modelForm.modelName}
                required
                onChange={(value) => setModelForm({ ...modelForm, modelName: value })}
              />
              <div className="grid gap-4 md:grid-cols-2">
                {modelNumberFields.map((field) => (
                  <NumberField
                    key={field}
                    id={`model-${field}`}
                    label={t(`settings.fields.${field}`)}
                    value={modelForm[field]}
                    min={field === "requestMinIntervalMs" ? 0 : 1}
                    required
                    onChange={(value) => setModelForm({ ...modelForm, [field]: value })}
                  />
                ))}
              </div>
              <FieldError>{t("settings.models.requiredHint")}</FieldError>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsModelDialogOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={isSaving === "model"}>
                  {isSaving === "model" ? t("settings.saving") : t("settings.models.create")}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(deleteModelTarget)}
        onOpenChange={(open) => {
          if (!open && isSaving !== "model-delete") {
            setDeleteModelTarget(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.models.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.models.deleteDescription", {
                name: deleteModelTarget?.displayName ?? ""
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving === "model-delete"}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isSaving === "model-delete"}
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteModel();
              }}
            >
              {isSaving === "model-delete"
                ? t("delete.deleting")
                : t("settings.models.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function SettingsCard({
  title,
  description,
  action,
  children
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <SettingsIcon className="size-4" />
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function PlainTips({
  items
}: {
  items: Array<{
    labelKey: string;
    descriptionKey: string;
  }>;
}) {
  const { t } = useTranslation();

  return (
    <div className="px-1 text-sm leading-6 text-muted-foreground">
      <p className="font-medium text-foreground">{t("settings.tips.title")}</p>
      <ul className="mt-2 space-y-1">
        {items.map((item) => (
          <li key={item.descriptionKey}>
            <span className="font-medium text-foreground">{t(item.labelKey)}: </span>
            <span>{t(item.descriptionKey)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  min = 1,
  required = false,
  onChange
}: {
  id: string;
  label: string;
  value: EditableNumber;
  min?: number;
  required?: boolean;
  onChange: (value: EditableNumber) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        <RequiredLabel label={label} required={required} />
      </FieldLabel>
      <Input
        id={id}
        type="number"
        min={min}
        step={1}
        required={required}
        value={value === "" ? "" : String(value)}
        onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
      />
    </Field>
  );
}

function TextField({
  id,
  label,
  value,
  required = false,
  onChange
}: {
  id: string;
  label: string;
  value: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        <RequiredLabel label={label} required={required} />
      </FieldLabel>
      <Input
        id={id}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function RequiredLabel({ label, required }: { label: string; required: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      {required ? (
        <span aria-hidden="true" className="text-destructive">
          *
        </span>
      ) : null}
    </span>
  );
}

function SaveButton({ isSaving }: { isSaving: boolean }) {
  const { t } = useTranslation();

  return (
    <div>
      <Button type="submit" disabled={isSaving}>
        {isSaving ? t("settings.saving") : t("settings.save")}
      </Button>
    </div>
  );
}

function toEditableRateLimits(settings: RateLimitSettings): EditableRateLimitSettings {
  return {
    adminLogin: { ...settings.adminLogin },
    adminApi: { ...settings.adminApi },
    upload: { ...settings.upload },
    publicOpenApi: { ...settings.publicOpenApi }
  };
}

function toEditableWorkerSettings(settings: WorkerSettings): EditableWorkerSettings {
  return { ...settings };
}

function toEditablePublicationSettings(settings: PublicationSettings): EditablePublicationSettings {
  return { ...settings };
}

function toEditableUploadGenerationSettings(
  settings: UploadGenerationSettings
): EditableUploadGenerationSettings {
  return { ...settings };
}

function buildRateLimitSettings(input: EditableRateLimitSettings): RateLimitSettings | null {
  const adminLogin = buildRateLimitGroup(input.adminLogin);
  const adminApi = buildRateLimitGroup(input.adminApi);
  const upload = buildRateLimitGroup(input.upload);
  const publicOpenApi = buildRateLimitGroup(input.publicOpenApi);

  if (!adminLogin || !adminApi || !upload || !publicOpenApi) {
    return null;
  }

  return {
    adminLogin,
    adminApi,
    upload,
    publicOpenApi
  };
}

function buildRateLimitGroup(
  input: EditableRateLimitSettings[RateLimitGroup]
): RateLimitSettings[RateLimitGroup] | null {
  const max = readRequiredInteger(input.max);
  const windowSeconds = readRequiredInteger(input.windowSeconds);

  return max === null || windowSeconds === null ? null : { max, windowSeconds };
}

function buildWorkerSettings(input: EditableWorkerSettings): WorkerSettings | null {
  const settings = buildNumberRecord(input, workerNumberFields);

  return settings
    ? ({
        ...settings,
        hardDeleteVersionPurgeEnabled: input.hardDeleteVersionPurgeEnabled
      } as WorkerSettings)
    : null;
}

function buildPublicationSettings(input: EditablePublicationSettings): PublicationSettings | null {
  const settings = buildNumberRecord(input, publicationFields);

  return settings ? { mode: input.mode, ...(settings as Record<PublicationField, number>) } : null;
}

function buildUploadGenerationSettings(
  input: EditableUploadGenerationSettings
): UploadGenerationSettings | null {
  const settings = buildNumberRecord(input, uploadGenerationFields);

  return settings ? (settings as UploadGenerationSettings) : null;
}

function buildModelPayload(
  input: EditableModelForm
): Parameters<typeof createRuntimeModel>[0] | null {
  const contextWindowTokens = readRequiredInteger(input.contextWindowTokens);
  const requestMaxTimeoutMs = readRequiredInteger(input.requestMaxTimeoutMs);
  const requestIdleTimeoutMs = readRequiredInteger(input.requestIdleTimeoutMs);
  const suggestionConcurrency = readRequiredInteger(input.suggestionConcurrency);
  const transientRetryDelayMs = readRequiredInteger(input.transientRetryDelayMs);
  const requestMinIntervalMs = readRequiredInteger(input.requestMinIntervalMs, 0);

  if (
    contextWindowTokens === null ||
    requestMaxTimeoutMs === null ||
    requestIdleTimeoutMs === null ||
    suggestionConcurrency === null ||
    transientRetryDelayMs === null ||
    requestMinIntervalMs === null
  ) {
    return null;
  }

  return {
    displayName: input.displayName,
    apiMode: input.apiMode,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    modelName: input.modelName,
    contextWindowTokens,
    requestMaxTimeoutMs,
    requestIdleTimeoutMs,
    suggestionConcurrency,
    transientRetryDelayMs,
    requestMinIntervalMs,
    isActive: input.isActive
  };
}

function buildNumberRecord<TField extends string>(
  input: Record<TField, EditableNumber>,
  fields: readonly TField[]
): Record<TField, number> | null {
  const output = {} as Record<TField, number>;

  for (const field of fields) {
    const value = readRequiredInteger(input[field]);
    if (value === null) {
      return null;
    }
    output[field] = value;
  }

  return output;
}

function readRequiredInteger(value: EditableNumber, min = 1): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : null;
}

function createEmptyModelForm(): EditableModelForm {
  return {
    displayName: "",
    apiMode: "responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    modelName: "",
    contextWindowTokens: 200_000,
    requestMaxTimeoutMs: 600_000,
    requestIdleTimeoutMs: 120_000,
    suggestionConcurrency: 2,
    transientRetryDelayMs: 60_000,
    requestMinIntervalMs: 2_000,
    isActive: true
  };
}
