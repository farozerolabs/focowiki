import { useEffect, useState } from "react";
import { AdminHomePage } from "@/pages/AdminHomePage";
import { KnowledgeBaseDetailPage } from "@/pages/KnowledgeBaseDetailPage";
import { LoginPage } from "@/pages/LoginPage";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  checkAdminSession,
  createKnowledgeBase,
  createPublicOpenApiKey,
  deleteKnowledgeBase,
  deletePublicOpenApiKey,
  listKnowledgeBases,
  listPublicOpenApiKeys,
  logoutAdmin,
  setAdminAuthFailureHandler,
  type ApiFailure,
  type KnowledgeBase,
  type OneTimePublicOpenApiKey,
  type PublicOpenApiKey
} from "@/lib/admin-api";

type AuthState = "checking" | "anonymous" | "authenticated";

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingKnowledgeBases, setIsLoadingKnowledgeBases] = useState(false);
  const [selectedKnowledgeBase, setSelectedKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [publicOpenApiKeys, setPublicOpenApiKeys] = useState<PublicOpenApiKey[]>([]);
  const [publicOpenApiKeysNextCursor, setPublicOpenApiKeysNextCursor] = useState<string | null>(
    null
  );
  const [publicOpenApiKeysOneTimeKey, setPublicOpenApiKeysOneTimeKey] =
    useState<OneTimePublicOpenApiKey | null>(null);
  const [isLoadingPublicOpenApiKeys, setIsLoadingPublicOpenApiKeys] = useState(false);
  const [hasLoadedPublicOpenApiKeys, setHasLoadedPublicOpenApiKeys] = useState(false);

  useEffect(() => {
    setAdminAuthFailureHandler(() => {
      clearProtectedState();
      setAuthState("anonymous");
    });

    return () => setAdminAuthFailureHandler(null);
  }, []);

  useEffect(() => {
    let isActive = true;

    async function restoreSession() {
      const hasSession = await checkAdminSession();

      if (!isActive) {
        return;
      }

      if (!hasSession) {
        setAuthState("anonymous");
        return;
      }

      setAuthState("authenticated");
      setIsLoadingKnowledgeBases(true);

      const page = await listKnowledgeBases({});

      if (!isActive) {
        return;
      }

      setKnowledgeBases(page.items);
      setNextCursor(page.nextCursor);
      setIsLoadingKnowledgeBases(false);
    }

    void restoreSession();

    return () => {
      isActive = false;
    };
  }, []);

  async function handleAuthenticated() {
    setAuthState("authenticated");
    await loadKnowledgeBases({ replace: true });
  }

  async function handleLogout() {
    await logoutAdmin();
    setAuthState("anonymous");
    clearProtectedState();
  }

  function clearProtectedState() {
    setKnowledgeBases([]);
    setNextCursor(null);
    setSelectedKnowledgeBase(null);
    setIsLoadingKnowledgeBases(false);
    setPublicOpenApiKeys([]);
    setPublicOpenApiKeysNextCursor(null);
    setPublicOpenApiKeysOneTimeKey(null);
    setIsLoadingPublicOpenApiKeys(false);
    setHasLoadedPublicOpenApiKeys(false);
  }

  async function loadKnowledgeBases(input: { replace: boolean }) {
    setIsLoadingKnowledgeBases(true);
    const page = await listKnowledgeBases(input.replace ? {} : { cursor: nextCursor });
    setKnowledgeBases((current) => (input.replace ? page.items : [...current, ...page.items]));
    setNextCursor(page.nextCursor);
    setIsLoadingKnowledgeBases(false);
  }

  async function handleCreateKnowledgeBase(input: {
    name: string;
    description: string;
  }): Promise<{ knowledgeBase: KnowledgeBase } | ApiFailure> {
    const result = await createKnowledgeBase(input);

    if ("messageKey" in result) {
      return result;
    }

    setKnowledgeBases((current) => [result.knowledgeBase, ...current]);
    return result;
  }

  async function handleDeleteKnowledgeBase(
    knowledgeBase: KnowledgeBase
  ): Promise<ApiFailure | { deleted: true }> {
    const result = await deleteKnowledgeBase({ knowledgeBaseId: knowledgeBase.id });

    if ("messageKey" in result) {
      return result;
    }

    setKnowledgeBases((current) => current.filter((item) => item.id !== knowledgeBase.id));

    if (selectedKnowledgeBase?.id === knowledgeBase.id) {
      setSelectedKnowledgeBase(null);
    }

    return result;
  }

  async function loadPublicOpenApiKeys(input: { replace: boolean }) {
    setIsLoadingPublicOpenApiKeys(true);
    const page = await listPublicOpenApiKeys(
      input.replace ? {} : { cursor: publicOpenApiKeysNextCursor }
    );
    setPublicOpenApiKeys((current) => (input.replace ? page.items : [...current, ...page.items]));
    setPublicOpenApiKeysNextCursor(page.nextCursor);
    setPublicOpenApiKeysOneTimeKey(page.oneTimeKey);
    setHasLoadedPublicOpenApiKeys(true);
    setIsLoadingPublicOpenApiKeys(false);
  }

  function handleOpenApiKeysTabSelected() {
    if (!hasLoadedPublicOpenApiKeys && !isLoadingPublicOpenApiKeys) {
      void loadPublicOpenApiKeys({ replace: true });
    }
  }

  async function handleCreatePublicOpenApiKey(input: {
    name: string;
  }): Promise<{ key: PublicOpenApiKey; oneTimeKey: OneTimePublicOpenApiKey } | ApiFailure> {
    const result = await createPublicOpenApiKey(input);

    if ("messageKey" in result) {
      return result;
    }

    setPublicOpenApiKeys((current) => [result.key, ...current]);
    setPublicOpenApiKeysOneTimeKey(result.oneTimeKey);
    setHasLoadedPublicOpenApiKeys(true);
    return result;
  }

  async function handleDeletePublicOpenApiKey(
    key: PublicOpenApiKey
  ): Promise<{ deleted: true } | ApiFailure> {
    const result = await deletePublicOpenApiKey({ keyId: key.id });

    if ("messageKey" in result) {
      return result;
    }

    setPublicOpenApiKeys((current) =>
      current.map((item) => (item.id === key.id ? { ...item, status: "revoked" } : item))
    );

    return result;
  }

  if (authState === "checking") {
    return (
      <TooltipProvider>
        <main className="min-h-svh bg-background" aria-busy="true" />
      </TooltipProvider>
    );
  }

  if (authState === "anonymous") {
    return (
      <TooltipProvider>
        <LoginPage onAuthenticated={() => void handleAuthenticated()} />
      </TooltipProvider>
    );
  }

  if (selectedKnowledgeBase) {
    return (
      <TooltipProvider>
        <KnowledgeBaseDetailPage
          knowledgeBase={selectedKnowledgeBase}
          onBack={() => setSelectedKnowledgeBase(null)}
          onLogout={() => void handleLogout()}
        />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <AdminHomePage
        knowledgeBases={knowledgeBases}
        nextCursor={nextCursor}
        isLoading={isLoadingKnowledgeBases}
        publicOpenApiKeys={publicOpenApiKeys}
        publicOpenApiKeysNextCursor={publicOpenApiKeysNextCursor}
        publicOpenApiKeysOneTimeKey={publicOpenApiKeysOneTimeKey}
        isLoadingPublicOpenApiKeys={isLoadingPublicOpenApiKeys}
        onCreate={handleCreateKnowledgeBase}
        onDelete={handleDeleteKnowledgeBase}
        onCreatePublicOpenApiKey={handleCreatePublicOpenApiKey}
        onDeletePublicOpenApiKey={handleDeletePublicOpenApiKey}
        onLoadPublicOpenApiKeys={(input) => void loadPublicOpenApiKeys(input)}
        onOpenApiKeysTabSelected={handleOpenApiKeysTabSelected}
        onLoadMore={() => void loadKnowledgeBases({ replace: false })}
        onLogout={() => void handleLogout()}
        onOpenKnowledgeBase={setSelectedKnowledgeBase}
      />
    </TooltipProvider>
  );
}
