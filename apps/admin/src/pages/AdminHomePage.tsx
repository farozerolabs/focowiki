import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon
} from "lucide-react";
import { AdminPageHeader } from "@/components/admin-page-header";
import { DocumentationLink } from "@/components/documentation-link";
import { HomeSidebar, type HomeSection } from "@/components/home-sidebar";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { OpenApiKeysPanel } from "@/components/openapi-keys-panel";
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
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
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
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger
} from "@/components/ui/sidebar";
import {
  Pagination,
  PaginationContent,
  PaginationItem
} from "@/components/ui/pagination";
import type {
  ApiFailure,
  KnowledgeBase,
  OneTimePublicOpenApiKey,
  PublicOpenApiKey
} from "@/lib/admin-api";

const SettingsPanel = lazy(async () => {
  const module = await import("@/components/settings-panel");
  return { default: module.SettingsPanel };
});

type AdminHomePageProps = {
  activeSection: HomeSection;
  knowledgeBases: KnowledgeBase[];
  knowledgeBaseQuery: string;
  knowledgeBasePageNumber: number;
  hasPreviousKnowledgeBasePage: boolean;
  hasNextKnowledgeBasePage: boolean;
  isLoading: boolean;
  publicOpenApiKeys: PublicOpenApiKey[];
  publicOpenApiKeysNextCursor: string | null;
  publicOpenApiKeysOneTimeKey: OneTimePublicOpenApiKey | null;
  isLoadingPublicOpenApiKeys: boolean;
  onCreate: (input: {
    name: string;
    description: string;
  }) => Promise<{ knowledgeBase: KnowledgeBase } | ApiFailure>;
  onDelete: (knowledgeBase: KnowledgeBase) => Promise<{ deleted: true } | ApiFailure>;
  onUpdate: (input: {
    knowledgeBase: KnowledgeBase;
    name: string;
    description: string;
  }) => Promise<{ knowledgeBase: KnowledgeBase } | ApiFailure>;
  onCreatePublicOpenApiKey: (
    input: { name: string }
  ) => Promise<{ key: PublicOpenApiKey; oneTimeKey: OneTimePublicOpenApiKey } | ApiFailure>;
  onDeletePublicOpenApiKey: (key: PublicOpenApiKey) => Promise<{ deleted: true } | ApiFailure>;
  onDismissPublicOpenApiOneTimeKey: () => void;
  onLoadPublicOpenApiKeys: (input: { replace: boolean }) => void;
  onOpenApiKeysSelected: () => void;
  onSectionChange: (section: HomeSection) => void;
  onPreviousKnowledgeBasePage: () => void;
  onNextKnowledgeBasePage: () => void;
  onSearchKnowledgeBases: (query: string) => void;
  onLogout: () => void;
  onOpenKnowledgeBase: (knowledgeBase: KnowledgeBase) => void;
};

export function AdminHomePage({
  activeSection,
  knowledgeBases,
  knowledgeBaseQuery,
  knowledgeBasePageNumber,
  hasPreviousKnowledgeBasePage,
  hasNextKnowledgeBasePage,
  isLoading,
  publicOpenApiKeys,
  publicOpenApiKeysNextCursor,
  publicOpenApiKeysOneTimeKey,
  isLoadingPublicOpenApiKeys,
  onCreate,
  onUpdate,
  onDelete,
  onCreatePublicOpenApiKey,
  onDeletePublicOpenApiKey,
  onDismissPublicOpenApiOneTimeKey,
  onLoadPublicOpenApiKeys,
  onOpenApiKeysSelected,
  onSectionChange,
  onPreviousKnowledgeBasePage,
  onNextKnowledgeBasePage,
  onSearchKnowledgeBases,
  onLogout,
  onOpenKnowledgeBase
}: AdminHomePageProps) {
  const { t } = useTranslation();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<KnowledgeBase | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createError, setCreateError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBase | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [copiedKnowledgeBaseId, setCopiedKnowledgeBaseId] = useState("");
  const [knowledgeBaseSearchInput, setKnowledgeBaseSearchInput] = useState(knowledgeBaseQuery);
  const hasActiveKnowledgeBaseSearch = Boolean(knowledgeBaseQuery);

  useEffect(() => {
    setKnowledgeBaseSearchInput(knowledgeBaseQuery);
  }, [knowledgeBaseQuery]);

  useEffect(() => {
    const normalizedInput = knowledgeBaseSearchInput.trim();

    if (normalizedInput === knowledgeBaseQuery) {
      return;
    }

    const timeout = window.setTimeout(() => {
      onSearchKnowledgeBases(normalizedInput);
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [knowledgeBaseQuery, knowledgeBaseSearchInput, onSearchKnowledgeBases]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError("");
    setIsCreating(true);

    const result = editTarget
      ? await onUpdate({ knowledgeBase: editTarget, name, description })
      : await onCreate({ name, description });

    setIsCreating(false);

    if ("messageKey" in result) {
      setCreateError(result.messageKey);
      return;
    }

    setName("");
    setDescription("");
    setEditTarget(null);
    setIsDialogOpen(false);
  }

  function openCreateDialog() {
    setEditTarget(null);
    setName("");
    setDescription("");
    setCreateError("");
    setIsDialogOpen(true);
  }

  function openEditDialog(knowledgeBase: KnowledgeBase) {
    setEditTarget(knowledgeBase);
    setName(knowledgeBase.name);
    setDescription(knowledgeBase.description ?? "");
    setCreateError("");
    setIsDialogOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) {
      return;
    }

    setDeleteError("");
    setIsDeleting(true);
    const result = await onDelete(deleteTarget);
    setIsDeleting(false);

    if ("messageKey" in result) {
      setDeleteError(result.messageKey);
      return;
    }

    setDeleteTarget(null);
  }

  async function handleCopyKnowledgeBaseId(knowledgeBaseId: string) {
    await navigator.clipboard.writeText(knowledgeBaseId);
    setCopiedKnowledgeBaseId(knowledgeBaseId);
  }

  function handleSectionChange(section: HomeSection) {
    if (section === activeSection) {
      return;
    }

    onSectionChange(section);
    if (section === "openapi-keys") {
      onOpenApiKeysSelected();
    }
  }

  return (
    <SidebarProvider>
      <HomeSidebar
        appName={t("app.name")}
        activeSection={activeSection}
        labels={{
          navigation: t("home.sectionNavigation"),
          toggleSidebarRail: t("home.toggleSidebarRail"),
          knowledgeBases: t("home.knowledgeBasesTab"),
          openApiKeys: t("home.openapiKeysTab"),
          settings: t("settings.title"),
          logout: t("auth.logout")
        }}
        onSectionSelect={handleSectionChange}
        onLogout={onLogout}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        <AdminPageHeader
          start={
            <>
              <SidebarTrigger aria-label={t("home.toggleSidebar")} />
              <Separator orientation="vertical" className="h-4" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {activeSection === "knowledge-bases"
                    ? t("home.knowledgeBasesTab")
                    : activeSection === "openapi-keys"
                      ? t("home.openapiKeysTab")
                      : t("settings.title")}
                </p>
                <p className="truncate text-xs text-muted-foreground">{t("app.name")}</p>
              </div>
            </>
          }
          end={
            <>
              <DocumentationLink />
              <LanguageSwitch />
            </>
          }
        />
        <section className="min-w-0 flex-1 px-4 py-6 sm:px-6">
          {activeSection === "knowledge-bases" ? (
            <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-end">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex min-w-0 flex-1 flex-col gap-2 sm:w-80">
                  <label htmlFor="knowledge-base-search" className="sr-only">
                    {t("home.searchLabel")}
                  </label>
                  <div className="relative">
                    <Input
                      id="knowledge-base-search"
                      value={knowledgeBaseSearchInput}
                      maxLength={128}
                      className={knowledgeBaseSearchInput.trim() ? "pr-9" : undefined}
                      placeholder={t("home.searchPlaceholder")}
                      onChange={(event) => setKnowledgeBaseSearchInput(event.target.value)}
                    />
                    {knowledgeBaseSearchInput.trim() ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={t("home.clearSearch")}
                        onClick={() => {
                          setKnowledgeBaseSearchInput("");
                          onSearchKnowledgeBases("");
                        }}
                      >
                        <XIcon />
                      </Button>
                    ) : null}
                  </div>
                </div>
                <Button type="button" onClick={openCreateDialog}>
                  <PlusIcon data-icon="inline-start" />
                  {t("home.createAction")}
                </Button>
              </div>
            </div>

            {isLoading && knowledgeBases.length === 0 ? (
              <Alert>
                <AlertTitle>{t("home.loading")}</AlertTitle>
              </Alert>
            ) : null}

            {!isLoading && knowledgeBases.length === 0 && !hasActiveKnowledgeBaseSearch ? (
              <Card className="border-dashed">
                <CardHeader>
                  <CardTitle>{t("home.emptyTitle")}</CardTitle>
                  <CardDescription>{t("home.emptyDescription")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button type="button" variant="outline" onClick={openCreateDialog}>
                    <PlusIcon data-icon="inline-start" />
                    {t("home.createAction")}
                  </Button>
                </CardContent>
              </Card>
            ) : null}

            {!isLoading && knowledgeBases.length === 0 && hasActiveKnowledgeBaseSearch ? (
              <Card className="border-dashed">
                <CardHeader>
                  <CardTitle>{t("home.searchEmptyTitle")}</CardTitle>
                  <CardDescription>{t("home.searchEmptyDescription")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setKnowledgeBaseSearchInput("");
                      onSearchKnowledgeBases("");
                    }}
                  >
                    {t("home.clearSearch")}
                  </Button>
                </CardContent>
              </Card>
            ) : null}

            {knowledgeBases.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {knowledgeBases.map((knowledgeBase) => (
                  <Card
                    key={knowledgeBase.id}
                    className="relative min-h-44 transition-colors hover:bg-muted/40 focus-within:ring-3 focus-within:ring-ring/50"
                  >
                    <CardHeader className="gap-2">
                      <CardTitle className="text-base">{knowledgeBase.name}</CardTitle>
                      <CardDescription className="line-clamp-2 min-h-10">
                        {knowledgeBase.description || t("home.noDescription")}
                      </CardDescription>
                      <CardAction className="relative z-10">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t("delete.knowledgeBaseMenu", {
                                name: knowledgeBase.name
                              })}
                            >
                              <MoreHorizontalIcon />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                              <DropdownMenuItem onSelect={() => openEditDialog(knowledgeBase)}>
                                <PencilIcon />
                                {t("common.edit")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => {
                                  setDeleteError("");
                                  setDeleteTarget(knowledgeBase);
                                }}
                              >
                                <Trash2Icon />
                                {t("delete.action")}
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="relative z-10 mt-auto pointer-events-none">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-muted-foreground">
                            {t("home.knowledgeBaseIdLabel")}
                          </p>
                          <p className="truncate font-mono text-xs text-foreground/80">
                            {knowledgeBase.id}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="pointer-events-auto"
                          aria-label={t("home.copyKnowledgeBaseId", {
                            id: knowledgeBase.id
                          })}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleCopyKnowledgeBaseId(knowledgeBase.id);
                          }}
                        >
                          {copiedKnowledgeBaseId === knowledgeBase.id ? (
                            <CheckIcon />
                          ) : (
                            <CopyIcon />
                          )}
                        </Button>
                      </div>
                      {copiedKnowledgeBaseId === knowledgeBase.id ? (
                        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
                          {t("common.copied")}
                        </p>
                      ) : null}
                    </CardContent>
                    <button
                      type="button"
                      className="absolute inset-0 rounded-xl outline-none"
                      aria-label={knowledgeBase.name}
                      onClick={() => onOpenKnowledgeBase(knowledgeBase)}
                    />
                  </Card>
                ))}
              </div>
            ) : null}

            {knowledgeBases.length > 0 ? (
              <Pagination aria-label={t("pagination.label")}>
                <PaginationContent>
                  <PaginationItem>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onPreviousKnowledgeBasePage}
                      disabled={isLoading || !hasPreviousKnowledgeBasePage}
                    >
                      <ChevronLeftIcon data-icon="inline-start" />
                      {t("pagination.previous")}
                    </Button>
                  </PaginationItem>
                  <PaginationItem>
                    <span
                      aria-current="page"
                      className="flex h-8 items-center px-2 text-sm text-muted-foreground"
                    >
                      {isLoading
                        ? t("pagination.loading")
                        : t("pagination.currentPage", {
                            page: knowledgeBasePageNumber
                          })}
                    </span>
                  </PaginationItem>
                  <PaginationItem>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onNextKnowledgeBasePage}
                      disabled={isLoading || !hasNextKnowledgeBasePage}
                    >
                      {t("pagination.next")}
                      <ChevronRightIcon data-icon="inline-end" />
                    </Button>
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            ) : null}
            </div>
          ) : activeSection === "openapi-keys" ? (
            <OpenApiKeysPanel
              keys={publicOpenApiKeys}
              oneTimeKey={publicOpenApiKeysOneTimeKey}
              nextCursor={publicOpenApiKeysNextCursor}
              isLoading={isLoadingPublicOpenApiKeys}
              onCreate={onCreatePublicOpenApiKey}
              onDelete={onDeletePublicOpenApiKey}
              onDismissOneTimeKey={onDismissPublicOpenApiOneTimeKey}
              onLoadMore={() => onLoadPublicOpenApiKeys({ replace: false })}
            />
          ) : (
            <Suspense
              fallback={
                <Alert>
                  <AlertTitle>{t("settings.loading")}</AlertTitle>
                </Alert>
              }
            >
              <SettingsPanel />
            </Suspense>
          )}
        </section>
      </SidebarInset>

      <Dialog
        open={isDialogOpen}
        onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open && !isCreating) setEditTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editTarget ? t("home.editAction") : t("home.createAction")}
            </DialogTitle>
            <DialogDescription>
              {editTarget ? t("home.editDescription") : t("home.createDescription")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field data-invalid={Boolean(createError)}>
                <FieldLabel htmlFor="knowledge-base-name">{t("home.nameLabel")}</FieldLabel>
                <Input
                  id="knowledge-base-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="knowledge-base-description">
                  {t("home.descriptionLabel")}
                </FieldLabel>
                <Input
                  id="knowledge-base-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              {createError ? <FieldError>{t(createError)}</FieldError> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={!name.trim() || isCreating}>
                  {isCreating
                    ? t(editTarget ? "common.saving" : "home.creating")
                    : t(editTarget ? "common.save" : "home.createSubmit")}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && !isDeleting && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete.knowledgeBaseTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("delete.knowledgeBaseDescription", {
                name: deleteTarget?.name ?? ""
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <Alert variant="destructive">
              <AlertTitle>{t(deleteError)}</AlertTitle>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {isDeleting ? t("delete.deleting") : t("delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
  );
}
