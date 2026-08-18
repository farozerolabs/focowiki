import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon
} from "lucide-react";
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
import { EmbeddingSettingsPanel } from
  "@/components/embedding-settings-panel";
import { RerankerSettingsPanel } from
  "@/components/reranker-settings-panel";
import {
  activateRuntimeModel,
  createRuntimeModel,
  deleteRuntimeModel,
  fetchRuntimeSettings,
  pauseRuntimeModel,
  resumeRuntimeModel,
  updateGraphSettings,
  updateGeneratedSettings,
  updateMaintenanceSettings,
  updateRateLimitSettings,
  updateRuntimeModel,
  updateSearchSettings,
  updateSemanticSettings,
  updateWorkerSettings,
  type ApiFailure,
  type GraphSettings,
  type GeneratedSettings,
  type MaintenanceSettings,
  type RateLimitSettings,
  type RuntimeModelConfig,
  type RuntimeSettingsResponse,
  type SemanticSettings,
  type SearchSettings,
  type WorkerSettings
} from "@/lib/admin-api";
import { runtimeSettingFailureMessageKey } from "@/lib/runtime-setting-error";

const rateLimitGroups = [
  "adminLogin",
  "adminApi",
  "publicOpenApi"
] as const satisfies readonly (keyof RateLimitSettings)[];

const workerNumberFields = [
  "sourceFileConcurrency",
  "jobMaxAttempts",
  "jobRetryDelayMs",
  "completedJobRetentionDays"
] as const satisfies readonly (keyof WorkerSettings)[];

const generatedFields = [
  "directoryIndexMaxEntries",
  "directoryIndexMaxBytes",
  "rootSummaryLimit",
  "okfLogMaxEntries",
  "okfLogMaxBytes"
] as const satisfies readonly (keyof GeneratedSettings)[];

const graphNumberFields = [
  "candidateLimit",
  "acceptedEdgeLimit",
  "searchDefaultDepth",
  "searchMaxDepth",
  "searchDefaultFanout",
  "searchMaxFanout",
  "shardSize",
  "genericPhraseThreshold"
] as const satisfies readonly (keyof GraphSettings)[];

const maintenanceNumberFields = [
  "scanBatchSize",
  "maxAttempts",
  "retryDelayMs",
  "hardDeleteConcurrency",
  "hardDeleteDatabaseBatchSize",
  "hardDeleteObjectBatchSize",
  "hardDeleteMaxAttempts",
  "hardDeleteRetryDelayMs",
  "hardDeleteFailedRetentionDays"
] as const satisfies readonly (
  keyof Omit<MaintenanceSettings, "reconciliationEnabled">
)[];

const searchNumberFields = [
  "requestTimeoutMs",
  "engineSearchCutoffMs",
  "overfetchFactor",
  "indexBatchDocumentCount",
  "indexBatchCompressedBytes",
  "maxInFlightTasks",
  "taskPollIntervalMs",
  "taskTimeoutMs",
  "maxAttempts",
  "retryDelayMs",
  "cleanupBatchSize",
  "cropLength"
] as const satisfies readonly (keyof SearchSettings)[];

const semanticNumberFields = [
  "maximumChunkCharacters",
  "maximumChunks",
  "maximumEvidenceTargets",
  "graphRagAdapterTimeoutMs",
  "searchLaneCutoffMs",
  "queryEmbeddingConcurrency",
  "queryEmbeddingCacheEntries"
] as const satisfies readonly (keyof SemanticSettings)[];

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

const workerTipItems = workerNumberFields.map((field) => ({
  labelKey: `settings.fields.${field}`,
  descriptionKey: `settings.tips.worker.${field}`
}));

const generatedTipItems = generatedFields.map((field) => ({
    labelKey: `settings.fields.${field}`,
    descriptionKey: `settings.tips.generated.${field}`
  }));

const graphTipItems = graphNumberFields.map((field) => ({
  labelKey: `settings.fields.${field}`,
  descriptionKey: `settings.tips.graph.${field}`
}));

const maintenanceTipItems = [
  "reconciliationEnabled",
  ...maintenanceNumberFields
].map((field) => ({
  labelKey: `settings.fields.${field}`,
  descriptionKey: `settings.tips.maintenance.${field}`
}));

const searchTipItems = searchNumberFields.map((field) => ({
  labelKey: `settings.fields.${field}`,
  descriptionKey: `settings.tips.search.${field}`
}));

const semanticTipItems = semanticNumberFields.map((field) => ({
  labelKey: `settings.fields.${field}`,
  descriptionKey: `settings.tips.semantic.${field}`
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
type GeneratedField = (typeof generatedFields)[number];
type GraphNumberField = (typeof graphNumberFields)[number];
type MaintenanceNumberField = (typeof maintenanceNumberFields)[number];
type SearchNumberField = (typeof searchNumberFields)[number];
type SemanticNumberField = (typeof semanticNumberFields)[number];
type ModelApiMode = (typeof modelApiModes)[number];
type ModelNumberField = (typeof modelNumberFields)[number];

type EditableRateLimitSettings = Record<
  RateLimitGroup,
  {
    max: EditableNumber;
    windowSeconds: EditableNumber;
  }
>;
type EditableWorkerSettings = Record<WorkerNumberField, EditableNumber>;
type EditableGeneratedSettings = Record<GeneratedField, EditableNumber>;
type EditableGraphSettings = Record<GraphNumberField, EditableNumber>;
type EditableMaintenanceSettings = Record<MaintenanceNumberField, EditableNumber> &
  Pick<MaintenanceSettings, "reconciliationEnabled">;
type EditableSearchSettings = Record<SearchNumberField, EditableNumber>;
type EditableSemanticSettings = Record<SemanticNumberField, EditableNumber>;
type EditableModelForm = {
  displayName: string;
  apiMode: ModelApiMode;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  isActive: boolean;
} & Record<ModelNumberField, EditableNumber>;

type SettingsPanelProps = {
  section?: "runtime" | "models";
};

export function SettingsPanel({ section = "runtime" }: SettingsPanelProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<RuntimeSettingsResponse | null>(null);
  const [rateLimits, setRateLimits] = useState<EditableRateLimitSettings | null>(null);
  const [worker, setWorker] = useState<EditableWorkerSettings | null>(null);
  const [generated, setGenerated] = useState<EditableGeneratedSettings | null>(null);
  const [graph, setGraph] = useState<EditableGraphSettings | null>(null);
  const [maintenance, setMaintenance] = useState<EditableMaintenanceSettings | null>(null);
  const [search, setSearch] = useState<EditableSearchSettings | null>(null);
  const [semantic, setSemantic] = useState<EditableSemanticSettings | null>(null);
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState("");
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<RuntimeModelConfig | null>(null);
  const [hasModelFormError, setHasModelFormError] = useState(false);
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

  async function handleGeneratedSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!generated) {
      return;
    }
    const payload = buildGeneratedSettings(generated);
    if (!payload) {
      showNumberValidationError();
      return;
    }
    await saveSettings("generated", () => updateGeneratedSettings(payload));
  }

  async function handleGraphSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!graph) {
      return;
    }
    const payload = buildGraphSettings(graph);
    if (!payload) {
      showNumberValidationError();
      return;
    }
    await saveSettings("graph", () => updateGraphSettings(payload));
  }

  async function handleMaintenanceSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!maintenance) {
      return;
    }
    const payload = buildMaintenanceSettings(maintenance);
    if (!payload) {
      showNumberValidationError();
      return;
    }
    await saveSettings("maintenance", () => updateMaintenanceSettings(payload));
  }

  async function handleSearchSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!search) return;
    const payload = buildSearchSettings(search);
    if (!payload) {
      showNumberValidationError();
      return;
    }
    await saveSettings("search", () => updateSearchSettings(payload));
  }

  async function handleSemanticSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!semantic) return;
    const payload = buildSemanticSettings(semantic, search);
    if (!payload) {
      showNumberValidationError();
      return;
    }
    await saveSettings("semantic", () => updateSemanticSettings(payload));
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
      setError(runtimeSettingFailureMessageKey(result));
      return;
    }

    setData((current) => (current ? { ...current, settings: result.settings } : current));
    setRateLimits(toEditableRateLimits(result.settings.rateLimits));
    setWorker(toEditableWorkerSettings(result.settings.worker));
    setGenerated(toEditableGeneratedSettings(result.settings.generated));
    setGraph(toEditableGraphSettings(result.settings.graph));
    setMaintenance(toEditableMaintenanceSettings(result.settings.maintenance));
    setSearch(toEditableSearchSettings(result.settings.search));
    setSemantic(toEditableSemanticSettings(result.settings.semantic));
    showAdminToast({ title: t("settings.toast.saveSuccess") });
  }

  async function handleCreateModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = buildModelPayload(modelForm, Boolean(editingModel));
    if (!payload) {
      const messageKey = "settings.models.requiredHint";
      setHasModelFormError(true);
      showAdminToast({
        title: t("settings.toast.saveFailed"),
        description: t(messageKey),
        variant: "destructive"
      });
      return;
    }
    setHasModelFormError(false);
    setIsSaving("model");
    setError("");
    const result = editingModel
      ? await updateRuntimeModel(editingModel.id, withoutActiveFlag(payload))
      : await createRuntimeModel(payload);
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
    setEditingModel(null);
    setHasModelFormError(false);
    setModelForm(createEmptyModelForm());
    showAdminToast({ title: t("settings.toast.modelCreated") });
    await loadSettings();
  }

  function applySettingsResponse(result: RuntimeSettingsResponse) {
    setData(result);
    setRateLimits(toEditableRateLimits(result.settings.rateLimits));
    setWorker(toEditableWorkerSettings(result.settings.worker));
    setGenerated(toEditableGeneratedSettings(result.settings.generated));
    setGraph(toEditableGraphSettings(result.settings.graph));
    setMaintenance(toEditableMaintenanceSettings(result.settings.maintenance));
    setSearch(toEditableSearchSettings(result.settings.search));
    setSemantic(toEditableSemanticSettings(result.settings.semantic));
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
    <div className="flex min-w-0 flex-col gap-6">
      <section className="flex min-w-0 flex-col gap-6">
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
          <Tabs
            key={section}
            defaultValue={section === "models" ? "embeddings" : "rate-limits"}
            className="min-w-0"
          >
            <div className="max-w-full overflow-x-auto">
              <TabsList>
                {section === "runtime" ? (
                  <>
                    <TabsTrigger value="rate-limits">{t("settings.tabs.rateLimits")}</TabsTrigger>
                    <TabsTrigger value="worker">{t("settings.tabs.worker")}</TabsTrigger>
                    <TabsTrigger value="generated">{t("settings.tabs.generated")}</TabsTrigger>
                    <TabsTrigger value="graph">{t("settings.tabs.graph")}</TabsTrigger>
                    <TabsTrigger value="maintenance">{t("settings.tabs.maintenance")}</TabsTrigger>
                    <TabsTrigger value="search">{t("settings.tabs.search")}</TabsTrigger>
                    <TabsTrigger value="semantic">{t("settings.tabs.semantic")}</TabsTrigger>
                  </>
                ) : (
                  <>
                    <TabsTrigger value="embeddings">{t("settings.tabs.embeddings")}</TabsTrigger>
                    <TabsTrigger value="rerankers">{t("settings.tabs.rerankers")}</TabsTrigger>
                    <TabsTrigger value="models">{t("settings.tabs.models")}</TabsTrigger>
                  </>
                )}
              </TabsList>
            </div>
            {section === "runtime" ? (
              <>
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
                        </div>
                        <SaveButton isSaving={isSaving === "worker"} />
                      </FieldGroup>
                    </form>
                  </SettingsCard>
                  <PlainTips items={workerTipItems} />
                </div>
              ) : null}
            </TabsContent>
            <TabsContent value="generated">
              {generated ? (
                <div className="space-y-3">
                  <SettingsCard
                    title={t("settings.generated.title")}
                    description={t("settings.generated.description")}
                  >
                    <form noValidate onSubmit={handleGeneratedSave}>
                      <FieldGroup>
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                          {generatedFields.map((field) => (
                            <NumberField
                              key={field}
                              id={`generated-${field}`}
                              label={t(`settings.fields.${field}`)}
                              value={generated[field]}
                              required
                              onChange={(value) => setGenerated({ ...generated, [field]: value })}
                            />
                          ))}
                        </div>
                        <SaveButton isSaving={isSaving === "generated"} />
                      </FieldGroup>
                    </form>
                  </SettingsCard>
                  <PlainTips items={generatedTipItems} />
                </div>
              ) : null}
            </TabsContent>
            <TabsContent value="graph">
              {graph ? (
                <div className="space-y-3">
                  <SettingsCard
                    title={t("settings.graph.title")}
                    description={t("settings.graph.description")}
                  >
                    <form noValidate onSubmit={handleGraphSave}>
                      <FieldGroup>
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                          {graphNumberFields.map((field) => (
                            <NumberField
                              key={field}
                              id={`graph-${field}`}
                              label={t(`settings.fields.${field}`)}
                              min={
                                field === "searchDefaultDepth" || field === "searchMaxDepth"
                                  ? 0
                                  : 1
                              }
                              value={graph[field]}
                              required
                              onChange={(value) => setGraph({ ...graph, [field]: value })}
                            />
                          ))}
                        </div>
                        <SaveButton isSaving={isSaving === "graph"} />
                      </FieldGroup>
                    </form>
                  </SettingsCard>
                  <PlainTips items={graphTipItems} />
                </div>
              ) : null}
            </TabsContent>
            <TabsContent value="search">
              {search ? (
                <div className="space-y-3">
                  <SettingsCard
                    title={t("settings.search.title")}
                    description={t("settings.search.description")}
                  >
                    <form noValidate onSubmit={handleSearchSave}>
                      <FieldGroup>
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                          {searchNumberFields.map((field) => (
                            <NumberField
                              key={field}
                              id={`search-${field}`}
                              label={t(`settings.fields.${field}`)}
                              value={search[field]}
                              required
                              onChange={(value) => setSearch({ ...search, [field]: value })}
                            />
                          ))}
                        </div>
                        <SaveButton isSaving={isSaving === "search"} />
                      </FieldGroup>
                    </form>
                  </SettingsCard>
                  <PlainTips items={searchTipItems} />
                </div>
              ) : null}
            </TabsContent>
            <TabsContent value="semantic">
              {semantic ? (
                <div className="space-y-3">
                  <SettingsCard
                    title={t("settings.semantic.title")}
                    description={t("settings.semantic.description")}
                  >
                    <form noValidate onSubmit={handleSemanticSave}>
                      <FieldGroup>
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                          {semanticNumberFields.map((field) => (
                            <NumberField
                              key={field}
                              id={`semantic-${field}`}
                              label={t(`settings.fields.${field}`)}
                              min={semanticMinimum(field)}
                              max={semanticMaximum(field)}
                              value={semantic[field]}
                              required
                              onChange={(value) =>
                                setSemantic({ ...semantic, [field]: value })
                              }
                            />
                          ))}
                        </div>
                        <SaveButton isSaving={isSaving === "semantic"} />
                      </FieldGroup>
                    </form>
                  </SettingsCard>
                  <PlainTips items={semanticTipItems} />
                </div>
              ) : null}
            </TabsContent>
            <TabsContent value="maintenance">
              {maintenance ? (
                <div className="space-y-3">
                  <SettingsCard
                    title={t("settings.maintenance.title")}
                    description={t("settings.maintenance.description")}
                  >
                    <form noValidate onSubmit={handleMaintenanceSave}>
                      <FieldGroup>
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                          <Field>
                            <FieldLabel htmlFor="maintenance-reconciliationEnabled">
                              <RequiredLabel
                                label={t("settings.fields.reconciliationEnabled")}
                                required
                              />
                            </FieldLabel>
                            <label className="flex min-h-9 items-center gap-2 rounded-md border border-input px-3 text-sm">
                              <Checkbox
                                id="maintenance-reconciliationEnabled"
                                checked={maintenance.reconciliationEnabled}
                                onCheckedChange={(checked) =>
                                  setMaintenance({
                                    ...maintenance,
                                    reconciliationEnabled: checked === true
                                  })
                                }
                              />
                              <span>{t("settings.fields.reconciliationEnabled")}</span>
                            </label>
                          </Field>
                          {maintenanceNumberFields.map((field) => (
                            <NumberField
                              key={field}
                              id={`maintenance-${field}`}
                              label={t(`settings.fields.${field}`)}
                              min={1}
                              {...(field === "scanBatchSize"
                                ? { max: 1_000 }
                                : {})}
                              value={maintenance[field]}
                              required
                              onChange={(value) =>
                                setMaintenance({ ...maintenance, [field]: value })
                              }
                            />
                          ))}
                        </div>
                        <SaveButton isSaving={isSaving === "maintenance"} />
                      </FieldGroup>
                    </form>
                  </SettingsCard>
                  <PlainTips items={maintenanceTipItems} />
                </div>
              ) : null}
            </TabsContent>
              </>
            ) : (
              <>
            <TabsContent value="models">
              <div className="space-y-3">
                <SettingsCard
                  title={t("settings.models.title")}
                  description={t("settings.models.description")}
                  action={
                    <Button
                      type="button"
                      onClick={() => {
                        setHasModelFormError(false);
                        setEditingModel(null);
                        setModelForm(createEmptyModelForm());
                        setIsModelDialogOpen(true);
                      }}
                    >
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
                                variant="outline"
                                onClick={() => {
                                  setHasModelFormError(false);
                                  setEditingModel(model);
                                  setModelForm(toEditableModelForm(model));
                                  setIsModelDialogOpen(true);
                                }}
                              >
                                <PencilIcon data-icon="inline-start" />
                                {t("common.edit")}
                              </Button>
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
            <TabsContent value="embeddings">
              <EmbeddingSettingsPanel />
            </TabsContent>
            <TabsContent value="rerankers">
              <RerankerSettingsPanel />
            </TabsContent>
              </>
            )}
          </Tabs>
        )}
      </section>
      <Dialog
        open={isModelDialogOpen}
        onOpenChange={(open) => {
          setIsModelDialogOpen(open);
          if (!open) {
            setHasModelFormError(false);
            setEditingModel(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingModel ? t("settings.models.update") : t("settings.models.add")}
            </DialogTitle>
            <DialogDescription>
              {editingModel
                ? t("settings.models.updateDescription")
                : t("settings.models.addDescription")}
            </DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={handleCreateModel}>
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
                required={!editingModel}
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
              {hasModelFormError ? (
                <FieldError>{t("settings.models.requiredHint")}</FieldError>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setHasModelFormError(false);
                    setEditingModel(null);
                    setIsModelDialogOpen(false);
                  }}
                >
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={isSaving === "model"}>
                  {isSaving === "model"
                    ? t("settings.saving")
                    : editingModel
                      ? t("settings.models.update")
                      : t("settings.models.create")}
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
    </div>
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
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <SettingsIcon className="size-4" />
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {action}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
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
  max,
  disabled = false,
  required = false,
  onChange
}: {
  id: string;
  label: string;
  value: EditableNumber;
  min?: number;
  max?: number;
  disabled?: boolean;
  required?: boolean;
  onChange: (value: EditableNumber) => void;
}) {
  return (
    <Field data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>
        <RequiredLabel label={label} required={required} />
      </FieldLabel>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={1}
        required={required}
        disabled={disabled}
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
    publicOpenApi: { ...settings.publicOpenApi }
  };
}

function toEditableWorkerSettings(settings: WorkerSettings): EditableWorkerSettings {
  return { ...settings };
}

function toEditableGeneratedSettings(settings: GeneratedSettings): EditableGeneratedSettings {
  return { ...settings };
}

function toEditableGraphSettings(settings: GraphSettings): EditableGraphSettings {
  return { ...settings };
}

function toEditableMaintenanceSettings(
  settings: MaintenanceSettings
): EditableMaintenanceSettings {
  return { ...settings };
}

function toEditableSearchSettings(settings: SearchSettings): EditableSearchSettings {
  return { ...settings };
}

function toEditableSemanticSettings(
  settings: SemanticSettings
): EditableSemanticSettings {
  return { ...settings };
}

function buildRateLimitSettings(input: EditableRateLimitSettings): RateLimitSettings | null {
  const adminLogin = buildRateLimitGroup(input.adminLogin);
  const adminApi = buildRateLimitGroup(input.adminApi);
  const publicOpenApi = buildRateLimitGroup(input.publicOpenApi);

  if (!adminLogin || !adminApi || !publicOpenApi) {
    return null;
  }

  return {
    adminLogin,
    adminApi,
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
  return settings as WorkerSettings | null;
}

function buildGeneratedSettings(input: EditableGeneratedSettings): GeneratedSettings | null {
  const settings = buildNumberRecord(input, generatedFields);
  return settings as GeneratedSettings | null;
}

function buildGraphSettings(input: EditableGraphSettings): GraphSettings | null {
  const settings = {} as Record<GraphNumberField, number>;

  for (const field of graphNumberFields) {
    const min = field === "searchDefaultDepth" || field === "searchMaxDepth" ? 0 : 1;
    const value = readRequiredInteger(input[field], min);
    if (value === null) {
      return null;
    }
    settings[field] = value;
  }

  if (!isGraphDepth(settings.searchDefaultDepth) || !isGraphDepth(settings.searchMaxDepth)) {
    return null;
  }

  return {
    ...(settings as Record<GraphNumberField, number>),
    searchDefaultDepth: settings.searchDefaultDepth,
    searchMaxDepth: settings.searchMaxDepth
  };
}

function buildMaintenanceSettings(
  input: EditableMaintenanceSettings
): MaintenanceSettings | null {
  const settings = buildNumberRecord(input, maintenanceNumberFields);
  if (!settings) {
    return null;
  }
  if (
    settings.scanBatchSize > 1_000 ||
    settings.hardDeleteConcurrency > 16
  ) {
    return null;
  }

  return {
    reconciliationEnabled: input.reconciliationEnabled,
    ...settings
  };
}

function buildSearchSettings(input: EditableSearchSettings): SearchSettings | null {
  const settings = buildNumberRecord(input, searchNumberFields);
  if (
    !settings
    || settings.requestTimeoutMs < 100
    || settings.requestTimeoutMs > 30_000
    || settings.engineSearchCutoffMs < 50
    || settings.engineSearchCutoffMs > settings.requestTimeoutMs
    || settings.overfetchFactor > 10
    || settings.indexBatchDocumentCount > 10_000
    || settings.indexBatchCompressedBytes < 65_536
    || settings.indexBatchCompressedBytes > 33_554_432
    || settings.maxInFlightTasks > 32
    || settings.taskPollIntervalMs < 100
    || settings.taskPollIntervalMs > 30_000
    || settings.taskTimeoutMs < 10_000
    || settings.taskTimeoutMs > 3_600_000
    || settings.maxAttempts > 20
    || settings.retryDelayMs < 100
    || settings.retryDelayMs > 300_000
    || settings.cleanupBatchSize > 5_000
    || settings.cropLength < 50
    || settings.cropLength > 5_000
  ) {
    return null;
  }
  return settings as SearchSettings;
}

function buildSemanticSettings(
  input: EditableSemanticSettings,
  search: EditableSearchSettings | null
): SemanticSettings | null {
  const settings = buildNumberRecord(input, semanticNumberFields, 0);
  if (!settings || !search) return null;
  for (const field of semanticNumberFields) {
    if (
      settings[field] < semanticMinimum(field)
      || settings[field] > semanticMaximum(field)
    ) return null;
  }
  const requestTimeoutMs = readRequiredInteger(search.requestTimeoutMs);
  if (requestTimeoutMs === null || settings.searchLaneCutoffMs > requestTimeoutMs) {
    return null;
  }
  return settings as SemanticSettings;
}

function semanticMinimum(field: SemanticNumberField): number {
  if (field === "graphRagAdapterTimeoutMs") return 100;
  if (field === "searchLaneCutoffMs") return 50;
  return 1;
}

function semanticMaximum(field: SemanticNumberField): number {
  const values: Record<SemanticNumberField, number> = {
    maximumChunkCharacters: 64_000,
    maximumChunks: 32,
    maximumEvidenceTargets: 256,
    graphRagAdapterTimeoutMs: 300_000,
    searchLaneCutoffMs: 3_000,
    queryEmbeddingConcurrency: 32,
    queryEmbeddingCacheEntries: 10_000
  };
  return values[field];
}

function isGraphDepth(value: number): value is GraphSettings["searchDefaultDepth"] {
  return value === 0 || value === 1 || value === 2;
}

function buildModelPayload(
  input: EditableModelForm,
  allowEmptyApiKey = false
): Parameters<typeof createRuntimeModel>[0] | null {
  const displayName = input.displayName.trim();
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();
  const modelName = input.modelName.trim();
  const contextWindowTokens = readRequiredInteger(input.contextWindowTokens);
  const requestMaxTimeoutMs = readRequiredInteger(input.requestMaxTimeoutMs);
  const requestIdleTimeoutMs = readRequiredInteger(input.requestIdleTimeoutMs);
  const suggestionConcurrency = readRequiredInteger(input.suggestionConcurrency);
  const transientRetryDelayMs = readRequiredInteger(input.transientRetryDelayMs);
  const requestMinIntervalMs = readRequiredInteger(input.requestMinIntervalMs, 0);

  if (
    !displayName ||
    !baseUrl ||
    (!allowEmptyApiKey && !apiKey) ||
    !modelName ||
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
    displayName,
    apiMode: input.apiMode,
    baseUrl,
    apiKey,
    modelName,
    contextWindowTokens,
    requestMaxTimeoutMs,
    requestIdleTimeoutMs,
    suggestionConcurrency,
    transientRetryDelayMs,
    requestMinIntervalMs,
    isActive: input.isActive
  };
}

function withoutActiveFlag(
  input: Parameters<typeof createRuntimeModel>[0]
): Parameters<typeof updateRuntimeModel>[1] {
  const { isActive: _isActive, ...value } = input;
  return value;
}

function toEditableModelForm(model: RuntimeModelConfig): EditableModelForm {
  return {
    displayName: model.displayName,
    apiMode: model.apiMode,
    baseUrl: model.baseUrl,
    apiKey: "",
    modelName: model.modelName,
    contextWindowTokens: model.contextWindowTokens,
    requestMaxTimeoutMs: model.requestMaxTimeoutMs,
    requestIdleTimeoutMs: model.requestIdleTimeoutMs,
    suggestionConcurrency: model.suggestionConcurrency,
    transientRetryDelayMs: model.transientRetryDelayMs,
    requestMinIntervalMs: model.requestMinIntervalMs,
    isActive: model.isActive
  };
}

function buildNumberRecord<TField extends string>(
  input: Record<TField, EditableNumber>,
  fields: readonly TField[],
  minimum = 1
): Record<TField, number> | null {
  const output = {} as Record<TField, number>;

  for (const field of fields) {
    const value = readRequiredInteger(input[field], minimum);
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
    isActive: false
  };
}
