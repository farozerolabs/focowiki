import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontalIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  ApiFailure,
  KnowledgeBase,
  OneTimePublicOpenApiKey,
  PublicOpenApiKey
} from "@/lib/admin-api";

type AdminHomePageProps = {
  knowledgeBases: KnowledgeBase[];
  nextCursor: string | null;
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
  onCreatePublicOpenApiKey: (
    input: { name: string }
  ) => Promise<{ key: PublicOpenApiKey; oneTimeKey: OneTimePublicOpenApiKey } | ApiFailure>;
  onDeletePublicOpenApiKey: (key: PublicOpenApiKey) => Promise<{ deleted: true } | ApiFailure>;
  onLoadPublicOpenApiKeys: (input: { replace: boolean }) => void;
  onOpenApiKeysTabSelected: () => void;
  onLoadMore: () => void;
  onLogout: () => void;
  onOpenKnowledgeBase: (knowledgeBase: KnowledgeBase) => void;
};

export function AdminHomePage({
  knowledgeBases,
  nextCursor,
  isLoading,
  publicOpenApiKeys,
  publicOpenApiKeysNextCursor,
  publicOpenApiKeysOneTimeKey,
  isLoadingPublicOpenApiKeys,
  onCreate,
  onDelete,
  onCreatePublicOpenApiKey,
  onDeletePublicOpenApiKey,
  onLoadPublicOpenApiKeys,
  onOpenApiKeysTabSelected,
  onLoadMore,
  onLogout,
  onOpenKnowledgeBase
}: AdminHomePageProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState("knowledge-bases");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createError, setCreateError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBase | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError("");
    setIsCreating(true);

    const result = await onCreate({ name, description });

    setIsCreating(false);

    if ("messageKey" in result) {
      setCreateError(result.messageKey);
      return;
    }

    setName("");
    setDescription("");
    setIsDialogOpen(false);
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

  return (
    <main className="min-h-svh bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-sm text-muted-foreground">{t("app.name")}</p>
            <h1 className="text-xl font-medium">{t("home.title")}</h1>
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
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            setActiveTab(value);
            if (value === "openapi-keys") {
              onOpenApiKeysTabSelected();
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="knowledge-bases">{t("home.knowledgeBasesTab")}</TabsTrigger>
            <TabsTrigger value="openapi-keys">{t("home.openapiKeysTab")}</TabsTrigger>
          </TabsList>
          <TabsContent value="knowledge-bases" className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-medium">{t("home.cardsTitle")}</h2>
                <p className="text-sm text-muted-foreground">{t("home.cardsDescription")}</p>
              </div>
              <Button type="button" onClick={() => setIsDialogOpen(true)}>
                <PlusIcon data-icon="inline-start" />
                {t("home.createAction")}
              </Button>
            </div>

            {isLoading && knowledgeBases.length === 0 ? (
              <Alert>
                <AlertTitle>{t("home.loading")}</AlertTitle>
              </Alert>
            ) : null}

            {!isLoading && knowledgeBases.length === 0 ? (
              <Card className="border-dashed">
                <CardHeader>
                  <CardTitle>{t("home.emptyTitle")}</CardTitle>
                  <CardDescription>{t("home.emptyDescription")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button type="button" variant="outline" onClick={() => setIsDialogOpen(true)}>
                    <PlusIcon data-icon="inline-start" />
                    {t("home.createAction")}
                  </Button>
                </CardContent>
              </Card>
            ) : null}

            {knowledgeBases.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {knowledgeBases.map((knowledgeBase) => (
                  <Card
                    key={knowledgeBase.id}
                    size="sm"
                    className="relative transition-colors hover:bg-muted/40 focus-within:ring-3 focus-within:ring-ring/50"
                  >
                    <CardHeader>
                      <CardTitle>{knowledgeBase.name}</CardTitle>
                      <CardDescription>
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

            {nextCursor ? (
              <Button type="button" variant="outline" onClick={onLoadMore} disabled={isLoading}>
                {isLoading ? t("home.loading") : t("home.loadMore")}
              </Button>
            ) : null}
          </TabsContent>
          <TabsContent value="openapi-keys">
            <OpenApiKeysPanel
              keys={publicOpenApiKeys}
              oneTimeKey={publicOpenApiKeysOneTimeKey}
              nextCursor={publicOpenApiKeysNextCursor}
              isLoading={isLoadingPublicOpenApiKeys}
              onCreate={onCreatePublicOpenApiKey}
              onDelete={onDeletePublicOpenApiKey}
              onLoadMore={() => onLoadPublicOpenApiKeys({ replace: false })}
            />
          </TabsContent>
        </Tabs>
      </section>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("home.createAction")}</DialogTitle>
            <DialogDescription>{t("home.createDescription")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
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
                  {isCreating ? t("home.creating") : t("home.createSubmit")}
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
    </main>
  );
}
