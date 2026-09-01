import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  PencilIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  TestTube2Icon,
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { showAdminToast } from "@/hooks/use-admin-toast";
import {
  activateEmbeddingConfiguration,
  createEmbeddingConfiguration,
  deleteEmbeddingConfiguration,
  fetchEmbeddingConfigurations,
  pauseEmbeddingConfiguration,
  resumeEmbeddingConfiguration,
  testEmbeddingConfiguration,
  updateEmbeddingConfiguration,
  type ApiFailure,
  type EmbeddingConfiguration,
  type EmbeddingConfigurationDraft
} from "@/lib/admin-api";

type EditableNumber = number | "";
type EmbeddingForm = {
  displayName: string;
  authenticationMode: EmbeddingConfiguration["authenticationMode"];
  baseUrl: string;
  apiKey: string;
  modelName: string;
  requestedDimension: EditableNumber;
  normalization: EmbeddingConfiguration["normalization"];
  maximumInputTokens: EditableNumber;
  batchSize: EditableNumber;
  timeoutMs: EditableNumber;
  retryCount: EditableNumber;
  minimumIntervalMs: EditableNumber;
  concurrency: EditableNumber;
  maximumResponseBytes: EditableNumber;
};

const numberFields = [
  "requestedDimension",
  "maximumInputTokens",
  "batchSize",
  "timeoutMs",
  "retryCount",
  "minimumIntervalMs",
  "concurrency",
  "maximumResponseBytes"
] as const;

export function EmbeddingSettingsPanel() {
  const { t } = useTranslation();
  const [configurations, setConfigurations] = useState<EmbeddingConfiguration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<EmbeddingConfiguration | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EmbeddingConfiguration | null>(null);
  const [form, setForm] = useState(createEmptyForm);
  const [formError, setFormError] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    const result = await fetchEmbeddingConfigurations();
    setLoading(false);
    if ("messageKey" in result) {
      setError(result.messageKey);
      return;
    }
    setError("");
    setConfigurations(result.configurations);
  }

  function openCreate() {
    setEditing(null);
    setForm(createEmptyForm());
    setFormError(false);
    setDialogOpen(true);
  }

  function openEdit(configuration: EmbeddingConfiguration) {
    setEditing(configuration);
    setForm(toForm(configuration));
    setFormError(false);
    setDialogOpen(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = buildDraft(form, editing);
    if (!draft) {
      setFormError(true);
      return;
    }
    setBusy("save");
    const result = editing
      ? await updateEmbeddingConfiguration({
          configurationId: editing.publicId,
          expectedRevision: editing.revision,
          configuration: draft
        })
      : await createEmbeddingConfiguration(draft);
    setBusy("");
    if (failed(result)) return showFailure(result);
    setDialogOpen(false);
    showAdminToast({ title: t("settings.embeddings.toast.saved") });
    await load();
  }

  async function runAction(
    key: string,
    successTitle: string,
    action: () => Promise<{ configuration: EmbeddingConfiguration } | ApiFailure>
  ) {
    setBusy(key);
    const result = await action();
    setBusy("");
    if (failed(result)) return showFailure(result);
    showAdminToast({ title: successTitle });
    await load();
  }

  async function remove() {
    if (!deleteTarget) return;
    setBusy("delete");
    const result = await deleteEmbeddingConfiguration(
      deleteTarget.publicId,
      deleteTarget.revision
    );
    setBusy("");
    if (failed(result)) return showFailure(result);
    setDeleteTarget(null);
    showAdminToast({ title: t("settings.embeddings.toast.deleted") });
    await load();
  }

  function showFailure(result: ApiFailure) {
    setError(result.messageKey);
    showAdminToast({
      title: t("settings.embeddings.toast.failed"),
      description: t(result.messageKey),
      variant: "destructive"
    });
  }

  return (
    <div className="space-y-3">
      {error ? <Alert variant="destructive"><AlertTitle>{t(error)}</AlertTitle></Alert> : null}
      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="flex flex-col items-start justify-between gap-4 sm:flex-row">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <SettingsIcon className="size-4" />
              {t("settings.embeddings.title")}
            </CardTitle>
            <CardDescription>{t("settings.embeddings.description")}</CardDescription>
          </div>
          <Button type="button" onClick={openCreate}>
            <PlusIcon data-icon="inline-start" />
            {t("settings.embeddings.add")}
          </Button>
        </CardHeader>
        <CardContent className="min-w-0">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t("settings.loading")}</p>
          ) : configurations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.embeddings.empty")}</p>
          ) : (
            <Table className="min-w-[1800px]">
              <TableHeader>
                <TableRow>
                  {[
                    "displayName", "authenticationMode", "baseUrl", "apiKey",
                    "modelName", ...numberFields, "normalization", "resolvedDimension",
                    "validationStatus", "lifecycleStatus", "actions"
                  ].map((field) => (
                    <TableHead key={field}>{t(`settings.fields.${field}`)}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {configurations.map((configuration) => (
                  <TableRow key={configuration.publicId}>
                    <TableCell>{configuration.displayName}</TableCell>
                    <TableCell>{t(`settings.embeddings.authentication.${configuration.authenticationMode}`)}</TableCell>
                    <TableCell>{configuration.baseUrl}</TableCell>
                    <TableCell>{configuration.apiKeyConfigured
                      ? t("settings.embeddings.secret.configured")
                      : t("settings.embeddings.secret.notConfigured")}</TableCell>
                    <TableCell>{configuration.modelName}</TableCell>
                    {numberFields.map((field) => (
                      <TableCell key={field}>{configuration[field] ?? "-"}</TableCell>
                    ))}
                    <TableCell>{t(`settings.embeddings.normalization.${configuration.normalization}`)}</TableCell>
                    <TableCell>{configuration.resolvedDimension ?? "-"}</TableCell>
                    <TableCell>{t(`settings.embeddings.validation.${configuration.validationStatus}`)}</TableCell>
                    <TableCell>{t(`settings.embeddings.lifecycle.${configuration.lifecycleStatus}`)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <ActionButton
                          label={t("settings.embeddings.test")}
                          busy={busy === `test-${configuration.publicId}`}
                          icon={<TestTube2Icon data-icon="inline-start" />}
                          onClick={() => void runAction(
                            `test-${configuration.publicId}`,
                            t("settings.embeddings.toast.tested"),
                            () => testEmbeddingConfiguration(configuration.publicId)
                          )}
                        />
                        <ActionButton
                          label={t("settings.embeddings.edit")}
                          icon={<PencilIcon data-icon="inline-start" />}
                          onClick={() => openEdit(configuration)}
                        />
                        {configuration.lifecycleStatus === "active" ? (
                          <ActionButton
                            label={t("settings.embeddings.pause")}
                            icon={<PauseIcon data-icon="inline-start" />}
                            onClick={() => void runAction(
                              `pause-${configuration.publicId}`,
                              t("settings.embeddings.toast.paused"),
                              () => pauseEmbeddingConfiguration(
                                configuration.publicId, configuration.revision
                              )
                            )}
                          />
                        ) : (
                          <>
                            {configuration.lifecycleStatus === "paused" ? (
                              <ActionButton
                                label={t("settings.embeddings.resume")}
                                icon={<PlayIcon data-icon="inline-start" />}
                                onClick={() => void runAction(
                                  `resume-${configuration.publicId}`,
                                  t("settings.embeddings.toast.resumed"),
                                  () => resumeEmbeddingConfiguration(
                                    configuration.publicId, configuration.revision
                                  )
                                )}
                              />
                            ) : null}
                            <ActionButton
                              label={t("settings.embeddings.activate")}
                              icon={<CheckIcon data-icon="inline-start" />}
                              onClick={() => void runAction(
                                `activate-${configuration.publicId}`,
                                t("settings.embeddings.toast.activated"),
                                () => activateEmbeddingConfiguration(
                                  configuration.publicId, configuration.revision
                                )
                              )}
                            />
                          </>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => setDeleteTarget(configuration)}
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
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t(editing
              ? "settings.embeddings.editTitle"
              : "settings.embeddings.add")}</DialogTitle>
            <DialogDescription>{t("settings.embeddings.formDescription")}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={submit}>
            <FieldGroup>
              <div className="grid gap-4 md:grid-cols-2">
                <TextInput id="embedding-displayName" field="displayName" form={form} setForm={setForm} />
                <SelectField
                  id="embedding-authenticationMode"
                  label={t("settings.fields.authenticationMode")}
                  value={form.authenticationMode}
                  onChange={(value) => setForm({
                    ...form,
                    authenticationMode: value as EmbeddingForm["authenticationMode"],
                    ...(value === "none" ? { apiKey: "" } : {})
                  })}
                  options={["api_key", "none"]}
                  optionLabel={(value) => t(`settings.embeddings.authentication.${value}`)}
                />
                <TextInput id="embedding-baseUrl" field="baseUrl" form={form} setForm={setForm} />
                <Field>
                  <FieldLabel htmlFor="embedding-apiKey">{t("settings.fields.apiKey")}</FieldLabel>
                  <Input
                    id="embedding-apiKey"
                    type="password"
                    disabled={form.authenticationMode === "none"}
                    value={form.apiKey}
                    placeholder={editing?.apiKeyConfigured
                      ? t("settings.embeddings.secret.keepExisting") : undefined}
                    onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  />
                </Field>
                <TextInput id="embedding-modelName" field="modelName" form={form} setForm={setForm} />
                <SelectField
                  id="embedding-normalization"
                  label={t("settings.fields.normalization")}
                  value={form.normalization}
                  onChange={(value) => setForm({
                    ...form,
                    normalization: value as EmbeddingForm["normalization"]
                  })}
                  options={["none", "l2"]}
                  optionLabel={(value) => t(`settings.embeddings.normalization.${value}`)}
                />
                {numberFields.map((field) => (
                  <NumberInput
                    key={field}
                    id={`embedding-${field}`}
                    field={field}
                    form={form}
                    setForm={setForm}
                  />
                ))}
              </div>
              {formError ? <FieldError>{t("settings.embeddings.validationError")}</FieldError> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={busy === "save"}>
                  {t(editing
                    ? "settings.embeddings.update"
                    : "settings.embeddings.create")}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => {
        if (!open && busy !== "delete") setDeleteTarget(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.embeddings.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.embeddings.deleteDescription", {
              name: deleteTarget?.displayName ?? ""
            })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => {
              event.preventDefault();
              void remove();
            }}>{t("settings.embeddings.deleteConfirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ActionButton(input: {
  label: string;
  icon: React.ReactNode;
  busy?: boolean;
  onClick: () => void;
}) {
  return <Button
    type="button"
    size="sm"
    variant="outline"
    disabled={input.busy}
    onClick={input.onClick}
  >{input.icon}{input.label}</Button>;
}

function TextInput(input: {
  id: string;
  field: "displayName" | "baseUrl" | "modelName";
  form: EmbeddingForm;
  setForm: (value: EmbeddingForm) => void;
}) {
  const { t } = useTranslation();
  return <Field>
    <FieldLabel htmlFor={input.id}>{t(`settings.fields.${input.field}`)}</FieldLabel>
    <Input
      id={input.id}
      required
      value={input.form[input.field]}
      onChange={(event) => input.setForm({
        ...input.form,
        [input.field]: event.target.value
      })}
    />
  </Field>;
}

function NumberInput(input: {
  id: string;
  field: (typeof numberFields)[number];
  form: EmbeddingForm;
  setForm: (value: EmbeddingForm) => void;
}) {
  const { t } = useTranslation();
  const optional = input.field === "requestedDimension";
  const descriptionId = optional ? `${input.id}-description` : undefined;
  return <Field>
    <FieldLabel htmlFor={input.id}>{t(`settings.fields.${input.field}`)}</FieldLabel>
    <Input
      id={input.id}
      aria-describedby={descriptionId}
      type="number"
      min={input.field === "retryCount"
        || input.field === "minimumIntervalMs" ? 0 : 1}
      step={1}
      required={!optional}
      value={input.form[input.field]}
      onChange={(event) => input.setForm({
        ...input.form,
        [input.field]: event.target.value === "" ? "" : Number(event.target.value)
      })}
    />
    {descriptionId ? (
      <FieldDescription id={descriptionId}>
        {t("settings.embeddings.requestedDimensionHint")}
      </FieldDescription>
    ) : null}
  </Field>;
}

function SelectField(input: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  optionLabel: (value: string) => string;
  onChange: (value: string) => void;
}) {
  return <Field>
    <FieldLabel htmlFor={input.id}>{input.label}</FieldLabel>
    <Select value={input.value} onValueChange={input.onChange}>
      <SelectTrigger id={input.id}><SelectValue /></SelectTrigger>
      <SelectContent>{input.options.map((option) =>
        <SelectItem key={option} value={option}>{input.optionLabel(option)}</SelectItem>
      )}</SelectContent>
    </Select>
  </Field>;
}

function createEmptyForm(): EmbeddingForm {
  return {
    displayName: "",
    authenticationMode: "api_key",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    modelName: "",
    requestedDimension: "",
    normalization: "l2",
    maximumInputTokens: 8192,
    batchSize: 32,
    timeoutMs: 30000,
    retryCount: 2,
    minimumIntervalMs: 0,
    concurrency: 4,
    maximumResponseBytes: 8388608
  };
}

function toForm(value: EmbeddingConfiguration): EmbeddingForm {
  return {
    displayName: value.displayName,
    authenticationMode: value.authenticationMode,
    baseUrl: value.baseUrl,
    apiKey: "",
    modelName: value.modelName,
    requestedDimension: value.requestedDimension ?? "",
    normalization: value.normalization,
    maximumInputTokens: value.maximumInputTokens,
    batchSize: value.batchSize,
    timeoutMs: value.timeoutMs,
    retryCount: value.retryCount,
    minimumIntervalMs: value.minimumIntervalMs,
    concurrency: value.concurrency,
    maximumResponseBytes: value.maximumResponseBytes
  };
}

function buildDraft(
  value: EmbeddingForm,
  existing: EmbeddingConfiguration | null
): EmbeddingConfigurationDraft | null {
  const requiredNumbers = [
    value.maximumInputTokens, value.batchSize, value.timeoutMs,
    value.retryCount, value.minimumIntervalMs, value.concurrency,
    value.maximumResponseBytes
  ];
  if (
    !value.displayName.trim() || !value.baseUrl.trim() || !value.modelName.trim()
    || requiredNumbers.some((number) => !Number.isSafeInteger(number))
    || value.authenticationMode === "api_key"
      && !value.apiKey.trim()
      && !existing?.apiKeyConfigured
  ) return null;
  return {
    displayName: value.displayName.trim(),
    authenticationMode: value.authenticationMode,
    baseUrl: value.baseUrl.trim(),
    apiKey: value.authenticationMode === "none"
      ? null : value.apiKey.trim() || null,
    modelName: value.modelName.trim(),
    requestedDimension: value.requestedDimension === ""
      ? null : value.requestedDimension,
    normalization: value.normalization,
    maximumInputTokens: value.maximumInputTokens as number,
    batchSize: value.batchSize as number,
    timeoutMs: value.timeoutMs as number,
    retryCount: value.retryCount as number,
    minimumIntervalMs: value.minimumIntervalMs as number,
    concurrency: value.concurrency as number,
    maximumResponseBytes: value.maximumResponseBytes as number
  };
}

function failed<T extends object>(value: T | ApiFailure): value is ApiFailure {
  return "messageKey" in value;
}
