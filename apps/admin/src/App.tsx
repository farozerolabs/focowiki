import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { AdminToaster } from "@/components/admin-toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AdminHomePage,
  KnowledgeBaseDetailPage,
  LoginPage
} from "@/pages/lazy-admin-pages";
import type { HomeSection } from "@/components/home-sidebar";
import {
  checkAdminSession,
  createKnowledgeBase,
  createPublicOpenApiKey,
  deleteKnowledgeBase,
  deletePublicOpenApiKey,
  fetchKnowledgeBase,
  listKnowledgeBases,
  listPublicOpenApiKeys,
  logoutAdmin,
  setAdminAuthFailureHandler,
  type ApiFailure,
  type KnowledgeBase,
  type OneTimePublicOpenApiKey,
  type PublicOpenApiKey
} from "@/lib/admin-api";
import { updateKnowledgeBaseMetadata } from "@/lib/resource-editing-api";
import { navigateAdminView, readAdminView, type AdminView } from "@/lib/admin-navigation";
import {
  completeCursorPageRequest,
  createInitialCursorPageState,
  moveToNextCursor,
  moveToPreviousCursor,
  type CursorPageState
} from "@/lib/cursor-page-state";

type AuthState = "checking" | "anonymous" | "authenticated";

function AdminPageBoundary({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <Suspense fallback={<main className="min-h-svh bg-background" aria-busy="true" />}>
        {children}
      </Suspense>
      <AdminToaster />
    </TooltipProvider>
  );
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [knowledgeBasePageState, setKnowledgeBasePageState] = useState<CursorPageState>(
    createInitialCursorPageState
  );
  const [isLoadingKnowledgeBases, setIsLoadingKnowledgeBases] = useState(false);
  const [knowledgeBaseListError, setKnowledgeBaseListError] = useState("");
  const [knowledgeBaseQuery, setKnowledgeBaseQuery] = useState("");
  const [selectedKnowledgeBase, setSelectedKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [homeSection, setHomeSection] = useState<HomeSection>("knowledge-bases");
  const [publicOpenApiKeys, setPublicOpenApiKeys] = useState<PublicOpenApiKey[]>([]);
  const [publicOpenApiKeysNextCursor, setPublicOpenApiKeysNextCursor] = useState<string | null>(
    null
  );
  const [publicOpenApiKeysOneTimeKey, setPublicOpenApiKeysOneTimeKey] =
    useState<OneTimePublicOpenApiKey | null>(null);
  const [isLoadingPublicOpenApiKeys, setIsLoadingPublicOpenApiKeys] = useState(false);
  const [publicOpenApiKeysError, setPublicOpenApiKeysError] = useState("");
  const knowledgeBaseLoadIdRef = useRef(0);
  const adminViewLoadIdRef = useRef(0);

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

      const initialPageState = createInitialCursorPageState();
      let page;
      try {
        page = await listKnowledgeBases({});
      } catch (error) {
        console.error("Failed to restore the knowledge base list.", error);
        if (isActive) {
          setIsLoadingKnowledgeBases(false);
          await restoreAdminView();
        }
        return;
      }

      if (!isActive) {
        return;
      }

      setKnowledgeBases(page.items);
      setKnowledgeBasePageState(completeCursorPageRequest(initialPageState, page.nextCursor));
      setIsLoadingKnowledgeBases(false);
      await restoreAdminView();
    }

    void restoreSession();

    return () => {
      isActive = false;
    };
  }, []);

  async function handleAuthenticated() {
    setAuthState("authenticated");
    const initialPageState = createInitialCursorPageState();
    setKnowledgeBasePageState(initialPageState);
    await loadKnowledgeBases({ pageState: initialPageState });
    await restoreAdminView();
  }

  async function handleLogout() {
    await logoutAdmin();
    navigateAdminView({ type: "home" }, "replace");
    setAuthState("anonymous");
    clearProtectedState();
  }

  async function restoreAdminView(view: AdminView = readAdminView()) {
    const loadId = adminViewLoadIdRef.current + 1;
    adminViewLoadIdRef.current = loadId;

    if (view.type === "home") {
      setSelectedKnowledgeBase(null);
      setHomeSection("knowledge-bases");
      return;
    }
    if (view.type === "settings") {
      setSelectedKnowledgeBase(null);
      setHomeSection("settings");
      return;
    }
    if (view.type === "model-settings") {
      setSelectedKnowledgeBase(null);
      setHomeSection("model-settings");
      return;
    }
    if (view.type === "openapi-keys") {
      setSelectedKnowledgeBase(null);
      setHomeSection("openapi-keys");
      await loadPublicOpenApiKeys({ replace: true });
      return;
    }

    let knowledgeBase;
    try {
      knowledgeBase = await fetchKnowledgeBase(view.knowledgeBaseId);
    } catch (error) {
      navigateAdminView({ type: "home" }, "replace");
      setSelectedKnowledgeBase(null);
      setHomeSection("knowledge-bases");
      setKnowledgeBaseListError(readRequestError(error));
      return;
    }
    if (loadId !== adminViewLoadIdRef.current) {
      return;
    }
    if (!knowledgeBase) {
      navigateAdminView({ type: "home" }, "replace");
      setSelectedKnowledgeBase(null);
      setHomeSection("knowledge-bases");
      return;
    }
    setHomeSection("knowledge-bases");
    setSelectedKnowledgeBase(knowledgeBase);
  }

  function openKnowledgeBase(knowledgeBase: KnowledgeBase) {
    navigateAdminView({ type: "knowledge-base", knowledgeBaseId: knowledgeBase.id });
    setHomeSection("knowledge-bases");
    setSelectedKnowledgeBase(knowledgeBase);
  }

  function handleHomeSectionChange(section: HomeSection) {
    if (section === "settings") {
      navigateAdminView({ type: "settings" });
    } else if (section === "model-settings") {
      navigateAdminView({ type: "model-settings" });
    } else if (section === "openapi-keys") {
      navigateAdminView({ type: "openapi-keys" });
    } else if (homeSection !== "knowledge-bases") {
      navigateAdminView({ type: "home" });
    }
    setSelectedKnowledgeBase(null);
    setHomeSection(section);
  }

  function returnHome() {
    navigateAdminView({ type: "home" });
    setSelectedKnowledgeBase(null);
    setHomeSection("knowledge-bases");
  }

  useEffect(() => {
    if (authState !== "authenticated") {
      return;
    }
    const handlePopState = () => void restoreAdminView();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [authState]);

  function clearProtectedState() {
    setKnowledgeBases([]);
    setKnowledgeBasePageState(createInitialCursorPageState());
    setKnowledgeBaseQuery("");
    setSelectedKnowledgeBase(null);
    setHomeSection("knowledge-bases");
    setIsLoadingKnowledgeBases(false);
    setKnowledgeBaseListError("");
    setPublicOpenApiKeys([]);
    setPublicOpenApiKeysNextCursor(null);
    setPublicOpenApiKeysOneTimeKey(null);
    setIsLoadingPublicOpenApiKeys(false);
    setPublicOpenApiKeysError("");
  }

  async function loadKnowledgeBases(input: { pageState?: CursorPageState; query?: string }) {
    const query = input.query ?? knowledgeBaseQuery;
    const normalizedQuery = query.trim();
    const pageState = input.pageState ?? knowledgeBasePageState;
    const loadId = knowledgeBaseLoadIdRef.current + 1;
    knowledgeBaseLoadIdRef.current = loadId;
    setIsLoadingKnowledgeBases(true);
    setKnowledgeBaseListError("");
    try {
      const page = await listKnowledgeBases({
        ...(pageState.currentCursor ? { cursor: pageState.currentCursor } : {}),
        ...(normalizedQuery ? { query: normalizedQuery } : {})
      });

      if (loadId !== knowledgeBaseLoadIdRef.current) {
        return;
      }

      setKnowledgeBases(page.items);
      setKnowledgeBasePageState(completeCursorPageRequest(pageState, page.nextCursor));
    } catch (error) {
      console.error("Failed to load the knowledge base list.", error);
      setKnowledgeBaseListError(readRequestError(error));
    } finally {
      if (loadId === knowledgeBaseLoadIdRef.current) {
        setIsLoadingKnowledgeBases(false);
      }
    }
  }

  async function handleKnowledgeBaseQueryChange(query: string) {
    const normalizedQuery = query.trim();
    const initialPageState = createInitialCursorPageState();
    setKnowledgeBaseQuery(normalizedQuery);
    setKnowledgeBasePageState(initialPageState);
    await loadKnowledgeBases({ pageState: initialPageState, query: normalizedQuery });
  }

  async function handleKnowledgeBaseNextPage() {
    const nextPageState = moveToNextCursor(knowledgeBasePageState);

    if (nextPageState === knowledgeBasePageState) {
      return;
    }

    setKnowledgeBasePageState(nextPageState);
    await loadKnowledgeBases({ pageState: nextPageState });
  }

  async function handleKnowledgeBasePreviousPage() {
    const previousPageState = moveToPreviousCursor(knowledgeBasePageState);

    if (previousPageState === knowledgeBasePageState) {
      return;
    }

    setKnowledgeBasePageState(previousPageState);
    await loadKnowledgeBases({ pageState: previousPageState });
  }

  async function handleCreateKnowledgeBase(input: {
    name: string;
    description: string;
  }): Promise<{ knowledgeBase: KnowledgeBase } | ApiFailure> {
    const result = await createKnowledgeBase(input);

    if ("messageKey" in result) {
      return result;
    }

    const initialPageState = createInitialCursorPageState();
    setKnowledgeBasePageState(initialPageState);
    await loadKnowledgeBases({ pageState: initialPageState, query: knowledgeBaseQuery });
    return result;
  }

  async function handleDeleteKnowledgeBase(
    knowledgeBase: KnowledgeBase
  ): Promise<ApiFailure | {
    accepted: true;
    operationId: string;
    affectedDirectoryCount: number;
    affectedFileCount: number;
  }> {
    const result = await deleteKnowledgeBase({ knowledgeBaseId: knowledgeBase.id });

    if ("messageKey" in result) {
      return result;
    }

    setKnowledgeBases((current) => current.filter((item) => item.id !== knowledgeBase.id));

    if (selectedKnowledgeBase?.id === knowledgeBase.id) {
      navigateAdminView({ type: "home" }, "replace");
      setSelectedKnowledgeBase(null);
    }

    return result;
  }

  async function handleUpdateKnowledgeBase(input: {
    knowledgeBase: KnowledgeBase;
    name: string;
    description: string;
  }): Promise<{ knowledgeBase: KnowledgeBase } | ApiFailure> {
    if (!input.knowledgeBase.resourceRevision) {
      return { messageKey: "errors.resourceRevisionConflict" };
    }
    const result = await updateKnowledgeBaseMetadata({
      knowledgeBaseId: input.knowledgeBase.id,
      resourceRevision: input.knowledgeBase.resourceRevision,
      name: input.name,
      description: input.description
    });
    if ("messageKey" in result) return result;
    const persisted = result.knowledgeBase;
    setSelectedKnowledgeBase((current) =>
      current?.id === persisted.id ? persisted : current
    );
    const initialPageState = createInitialCursorPageState();
    setKnowledgeBasePageState(initialPageState);
    await loadKnowledgeBases({ pageState: initialPageState, query: knowledgeBaseQuery });
    return { knowledgeBase: persisted };
  }

  async function loadPublicOpenApiKeys(input: { replace: boolean }) {
    setIsLoadingPublicOpenApiKeys(true);
    setPublicOpenApiKeysError("");
    try {
      const page = await listPublicOpenApiKeys(
        input.replace ? {} : { cursor: publicOpenApiKeysNextCursor }
      );
      setPublicOpenApiKeys((current) => (input.replace ? page.items : [...current, ...page.items]));
      setPublicOpenApiKeysNextCursor(page.nextCursor);
    } catch (error) {
      setPublicOpenApiKeysError(readRequestError(error));
    } finally {
      setIsLoadingPublicOpenApiKeys(false);
    }
  }

  function handleOpenApiKeysSelected() {
    if (!isLoadingPublicOpenApiKeys) {
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
    return result;
  }

  async function handleDeletePublicOpenApiKey(
    key: PublicOpenApiKey
  ): Promise<{ deleted: true } | ApiFailure> {
    const result = await deletePublicOpenApiKey({ keyId: key.id });

    if ("messageKey" in result) {
      return result;
    }

    setPublicOpenApiKeys((current) => current.filter((item) => item.id !== key.id));

    return result;
  }

  if (authState === "checking") {
    return (
      <AdminPageBoundary>
        <main className="min-h-svh bg-background" aria-busy="true" />
      </AdminPageBoundary>
    );
  }

  if (authState === "anonymous") {
    return (
      <AdminPageBoundary>
        <LoginPage onAuthenticated={() => void handleAuthenticated()} />
      </AdminPageBoundary>
    );
  }

  if (selectedKnowledgeBase) {
    return (
      <AdminPageBoundary>
        <KnowledgeBaseDetailPage
          knowledgeBase={selectedKnowledgeBase}
          onBack={returnHome}
          onLogout={() => void handleLogout()}
        />
      </AdminPageBoundary>
    );
  }

  return (
    <AdminPageBoundary>
      <AdminHomePage
        activeSection={homeSection}
        knowledgeBases={knowledgeBases}
        knowledgeBaseQuery={knowledgeBaseQuery}
        knowledgeBasePageNumber={knowledgeBasePageState.pageNumber}
        hasPreviousKnowledgeBasePage={knowledgeBasePageState.previousCursors.length > 0}
        hasNextKnowledgeBasePage={Boolean(knowledgeBasePageState.nextCursor)}
        isLoading={isLoadingKnowledgeBases}
        knowledgeBaseListError={knowledgeBaseListError}
        publicOpenApiKeys={publicOpenApiKeys}
        publicOpenApiKeysNextCursor={publicOpenApiKeysNextCursor}
        publicOpenApiKeysOneTimeKey={publicOpenApiKeysOneTimeKey}
        isLoadingPublicOpenApiKeys={isLoadingPublicOpenApiKeys}
        publicOpenApiKeysError={publicOpenApiKeysError}
        onCreate={handleCreateKnowledgeBase}
        onUpdate={handleUpdateKnowledgeBase}
        onDelete={handleDeleteKnowledgeBase}
        onCreatePublicOpenApiKey={handleCreatePublicOpenApiKey}
        onDeletePublicOpenApiKey={handleDeletePublicOpenApiKey}
        onDismissPublicOpenApiOneTimeKey={() => setPublicOpenApiKeysOneTimeKey(null)}
        onLoadPublicOpenApiKeys={(input) => void loadPublicOpenApiKeys(input)}
        onOpenApiKeysSelected={handleOpenApiKeysSelected}
        onSectionChange={handleHomeSectionChange}
        onPreviousKnowledgeBasePage={() => void handleKnowledgeBasePreviousPage()}
        onNextKnowledgeBasePage={() => void handleKnowledgeBaseNextPage()}
        onSearchKnowledgeBases={(query) => void handleKnowledgeBaseQueryChange(query)}
        onLogout={() => void handleLogout()}
        onOpenKnowledgeBase={openKnowledgeBase}
      />
    </AdminPageBoundary>
  );
}

function readRequestError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "errors.runtimeSettingsUnavailable";
}
