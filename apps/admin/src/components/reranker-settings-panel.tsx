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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  activateRerankerConfiguration,
  createRerankerConfiguration,
  deleteRerankerConfiguration,
  fetchRerankerConfigurations,
  pauseRerankerConfiguration,
  resumeRerankerConfiguration,
  testRerankerConfiguration,
  updateRerankerConfiguration,
  type ApiFailure,
  type RerankerConfiguration,
  type RerankerConfigurationDraft
} from "@/lib/admin-api";

type EditableNumber = number | "";
type RerankerForm = {
  displayName: string;
  authenticationMode: RerankerConfiguration["authenticationMode"];
  baseUrl: string;
  apiKey: string;
  modelName: string;
  timeoutMs: EditableNumber;
  retryCount: EditableNumber;
  minimumIntervalMs: EditableNumber;
  concurrency: EditableNumber;
};

const numberFields = [
  "timeoutMs",
  "retryCount",
  "minimumIntervalMs",
  "concurrency"
] as const;

export function RerankerSettingsPanel() {
  const { t } = useTranslation();
  const [configurations, setConfigurations] = useState<RerankerConfiguration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<RerankerConfiguration | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RerankerConfiguration | null>(null);
  const [form, setForm] = useState(createEmptyForm);
  const [formError, setFormError] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    const result = await fetchRerankerConfigurations();
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

  function openEdit(configuration: RerankerConfiguration) {
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
      ? await updateRerankerConfiguration({
          configurationId: editing.publicId,
          expectedRevision: editing.revision,
          configuration: draft
        })
      : await createRerankerConfiguration(draft);
    setBusy("");
    if (failed(result)) return showFailure(result);
    setDialogOpen(false);
    showAdminToast({ title: t("settings.rerankers.toast.saved") });
    await load();
  }

  async function runAction(
    key: string,
    successTitle: string,
    action: () => Promise<{ configuration: RerankerConfiguration } | ApiFailure>
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
    const result = await deleteRerankerConfiguration(
      deleteTarget.publicId,
      deleteTarget.revision
    );
    setBusy("");
    if (failed(result)) return showFailure(result);
    setDeleteTarget(null);
    showAdminToast({ title: t("settings.rerankers.toast.deleted") });
    await load();
  }

  function showFailure(result: ApiFailure) {
    setError(result.messageKey);
    showAdminToast({
      title: t("settings.rerankers.toast.failed"),
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
              {t("settings.rerankers.title")}
            </CardTitle>
            <CardDescription>{t("settings.rerankers.description")}</CardDescription>
          </div>
          <Button type="button" onClick={openCreate}>
            <PlusIcon data-icon="inline-start" />
            {t("settings.rerankers.add")}
          </Button>
        </CardHeader>
        <CardContent className="min-w-0">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t("settings.loading")}</p>
          ) : configurations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.rerankers.empty")}</p>
          ) : (
            <Table className="min-w-[1200px]">
              <TableHeader>
                <TableRow>
                  {[
                    "displayName", "authenticationMode", "baseUrl", "apiKey",
                    "modelName", ...numberFields, "validationStatus",
                    "lifecycleStatus", "actions"
                  ].map((field) => (
                    <TableHead key={field}>{t(`settings.fields.${field}`)}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {configurations.map((configuration) => (
                  <TableRow key={configuration.publicId}>
                    <TableCell>{configuration.displayName}</TableCell>
                    <TableCell>{t(`settings.rerankers.authentication.${configuration.authenticationMode}`)}</TableCell>
                    <TableCell>{configuration.baseUrl}</TableCell>
                    <TableCell>{configuration.apiKeyConfigured
                      ? t("settings.rerankers.secret.configured")
                      : t("settings.rerankers.secret.notConfigured")}</TableCell>
                    <TableCell>{configuration.modelName}</TableCell>
                    {numberFields.map((field) => (
                      <TableCell key={field}>{configuration[field]}</TableCell>
                    ))}
                    <TableCell>{t(`settings.rerankers.validation.${configuration.validationStatus}`)}</TableCell>
                    <TableCell>{t(`settings.rerankers.lifecycle.${configuration.lifecycleStatus}`)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <ActionButton
                          label={t("settings.rerankers.test")}
                          busy={busy === `test-${configuration.publicId}`}
                          icon={<TestTube2Icon data-icon="inline-start" />}
                          onClick={() => void runAction(
                            `test-${configuration.publicId}`,
                            t("settings.rerankers.toast.tested"),
                            () => testRerankerConfiguration(configuration.publicId)
                          )}
                        />
                        <ActionButton
                          label={t("settings.rerankers.edit")}
                          icon={<PencilIcon data-icon="inline-start" />}
                          onClick={() => openEdit(configuration)}
                        />
                        {configuration.lifecycleStatus === "active" ? (
                          <ActionButton
                            label={t("settings.rerankers.pause")}
                            icon={<PauseIcon data-icon="inline-start" />}
                            onClick={() => void runAction(
                              `pause-${configuration.publicId}`,
                              t("settings.rerankers.toast.paused"),
                              () => pauseRerankerConfiguration(
                                configuration.publicId, configuration.revision
                              )
                            )}
                          />
                        ) : (
                          <>
                            {configuration.lifecycleStatus === "paused" ? (
                              <ActionButton
                                label={t("settings.rerankers.resume")}
                                icon={<PlayIcon data-icon="inline-start" />}
                                onClick={() => void runAction(
                                  `resume-${configuration.publicId}`,
                                  t("settings.rerankers.toast.resumed"),
                                  () => resumeRerankerConfiguration(
                                    configuration.publicId, configuration.revision
                                  )
                                )}
                              />
                            ) : null}
                            <ActionButton
                              label={t("settings.rerankers.activate")}
                              icon={<CheckIcon data-icon="inline-start" />}
                              onClick={() => void runAction(
                                `activate-${configuration.publicId}`,
                                t("settings.rerankers.toast.activated"),
                                () => activateRerankerConfiguration(
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
              ? "settings.rerankers.editTitle"
              : "settings.rerankers.add")}</DialogTitle>
            <DialogDescription>{t("settings.rerankers.formDescription")}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={submit}>
            <FieldGroup>
              <div className="grid gap-4 md:grid-cols-2">
                <TextInput id="reranker-displayName" field="displayName" form={form} setForm={setForm} />
                <SelectField
                  id="reranker-authenticationMode"
                  label={t("settings.fields.authenticationMode")}
                  value={form.authenticationMode}
                  onChange={(value) => setForm({
                    ...form,
                    authenticationMode: value as RerankerForm["authenticationMode"],
                    ...(value === "none" ? { apiKey: "" } : {})
                  })}
                  options={["api_key", "none"]}
                  optionLabel={(value) => t(`settings.rerankers.authentication.${value}`)}
                />
                <TextInput id="reranker-baseUrl" field="baseUrl" form={form} setForm={setForm} />
                <Field>
                  <FieldLabel htmlFor="reranker-apiKey">{t("settings.fields.apiKey")}</FieldLabel>
                  <Input
                    id="reranker-apiKey"
                    type="password"
                    disabled={form.authenticationMode === "none"}
                    value={form.apiKey}
                    placeholder={editing?.apiKeyConfigured
                      ? t("settings.rerankers.secret.keepExisting") : undefined}
                    onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  />
                </Field>
                <TextInput id="reranker-modelName" field="modelName" form={form} setForm={setForm} />
                {numberFields.map((field) => (
                  <NumberInput
                    key={field}
                    id={`reranker-${field}`}
                    field={field}
                    form={form}
                    setForm={setForm}
                  />
                ))}
              </div>
              {formError ? <FieldError>{t("settings.rerankers.validationError")}</FieldError> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={busy === "save"}>
                  {t(editing
                    ? "settings.rerankers.update"
                    : "settings.rerankers.create")}
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
            <AlertDialogTitle>{t("settings.rerankers.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.rerankers.deleteDescription", {
              name: deleteTarget?.displayName ?? ""
            })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => {
              event.preventDefault();
              void remove();
            }}>{t("settings.rerankers.deleteConfirm")}</AlertDialogAction>
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
  form: RerankerForm;
  setForm: (value: RerankerForm) => void;
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
  form: RerankerForm;
  setForm: (value: RerankerForm) => void;
}) {
  const { t } = useTranslation();
  return <Field>
    <FieldLabel htmlFor={input.id}>{t(`settings.fields.${input.field}`)}</FieldLabel>
    <Input
      id={input.id}
      type="number"
      min={input.field === "retryCount" || input.field === "minimumIntervalMs" ? 0 : 1}
      step={1}
      required
      value={input.form[input.field]}
      onChange={(event) => input.setForm({
        ...input.form,
        [input.field]: event.target.value === "" ? "" : Number(event.target.value)
      })}
    />
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

function createEmptyForm(): RerankerForm {
  return {
    displayName: "",
    authenticationMode: "api_key",
    baseUrl: "",
    apiKey: "",
    modelName: "",
    timeoutMs: 30_000,
    retryCount: 2,
    minimumIntervalMs: 0,
    concurrency: 4
  };
}

function toForm(value: RerankerConfiguration): RerankerForm {
  return {
    displayName: value.displayName,
    authenticationMode: value.authenticationMode,
    baseUrl: value.baseUrl,
    apiKey: "",
    modelName: value.modelName,
    timeoutMs: value.timeoutMs,
    retryCount: value.retryCount,
    minimumIntervalMs: value.minimumIntervalMs,
    concurrency: value.concurrency
  };
}

function buildDraft(
  value: RerankerForm,
  existing: RerankerConfiguration | null
): RerankerConfigurationDraft | null {
  const numbers = [
    value.timeoutMs, value.retryCount, value.minimumIntervalMs, value.concurrency
  ];
  if (
    !value.displayName.trim() || !value.baseUrl.trim()
    || !value.modelName.trim()
    || numbers.some((number) => !Number.isSafeInteger(number))
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
    timeoutMs: value.timeoutMs as number,
    retryCount: value.retryCount as number,
    minimumIntervalMs: value.minimumIntervalMs as number,
    concurrency: value.concurrency as number
  };
}

function failed<T extends object>(value: T | ApiFailure): value is ApiFailure {
  return "messageKey" in value;
}
