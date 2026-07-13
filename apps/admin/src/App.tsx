import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { AdminToaster } from "@/components/admin-toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AdminHomePage,
  KnowledgeBaseDetailPage,
  LoginPage,
  SettingsPage
} from "@/pages/lazy-admin-pages";
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
  const [knowledgeBaseQuery, setKnowledgeBaseQuery] = useState("");
  const [selectedKnowledgeBase, setSelectedKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [publicOpenApiKeys, setPublicOpenApiKeys] = useState<PublicOpenApiKey[]>([]);
  const [publicOpenApiKeysNextCursor, setPublicOpenApiKeysNextCursor] = useState<string | null>(
    null
  );
  const [publicOpenApiKeysOneTimeKey, setPublicOpenApiKeysOneTimeKey] =
    useState<OneTimePublicOpenApiKey | null>(null);
  const [isLoadingPublicOpenApiKeys, setIsLoadingPublicOpenApiKeys] = useState(false);
  const [hasLoadedPublicOpenApiKeys, setHasLoadedPublicOpenApiKeys] = useState(false);
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
      const page = await listKnowledgeBases({});

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
      setIsSettingsOpen(false);
      return;
    }
    if (view.type === "settings") {
      setSelectedKnowledgeBase(null);
      setIsSettingsOpen(true);
      return;
    }

    const knowledgeBase = await fetchKnowledgeBase(view.knowledgeBaseId);
    if (loadId !== adminViewLoadIdRef.current) {
      return;
    }
    if (!knowledgeBase) {
      navigateAdminView({ type: "home" }, "replace");
      setSelectedKnowledgeBase(null);
      setIsSettingsOpen(false);
      return;
    }
    setIsSettingsOpen(false);
    setSelectedKnowledgeBase(knowledgeBase);
  }

  function openKnowledgeBase(knowledgeBase: KnowledgeBase) {
    navigateAdminView({ type: "knowledge-base", knowledgeBaseId: knowledgeBase.id });
    setIsSettingsOpen(false);
    setSelectedKnowledgeBase(knowledgeBase);
  }

  function openSettings() {
    navigateAdminView({ type: "settings" });
    setSelectedKnowledgeBase(null);
    setIsSettingsOpen(true);
  }

  function returnHome() {
    navigateAdminView({ type: "home" });
    setSelectedKnowledgeBase(null);
    setIsSettingsOpen(false);
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
    setIsSettingsOpen(false);
    setIsLoadingKnowledgeBases(false);
    setPublicOpenApiKeys([]);
    setPublicOpenApiKeysNextCursor(null);
    setPublicOpenApiKeysOneTimeKey(null);
    setIsLoadingPublicOpenApiKeys(false);
    setHasLoadedPublicOpenApiKeys(false);
  }

  async function loadKnowledgeBases(input: { pageState?: CursorPageState; query?: string }) {
    const query = input.query ?? knowledgeBaseQuery;
    const normalizedQuery = query.trim();
    const pageState = input.pageState ?? knowledgeBasePageState;
    const loadId = knowledgeBaseLoadIdRef.current + 1;
    knowledgeBaseLoadIdRef.current = loadId;
    setIsLoadingKnowledgeBases(true);
    const page = await listKnowledgeBases({
      ...(pageState.currentCursor ? { cursor: pageState.currentCursor } : {}),
      ...(normalizedQuery ? { query: normalizedQuery } : {})
    });

    if (loadId !== knowledgeBaseLoadIdRef.current) {
      return;
    }

    setKnowledgeBases(page.items);
    setKnowledgeBasePageState(completeCursorPageRequest(pageState, page.nextCursor));
    setIsLoadingKnowledgeBases(false);
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

    if (knowledgeBaseQuery || knowledgeBasePageState.pageNumber > 1) {
      const initialPageState = createInitialCursorPageState();
      setKnowledgeBasePageState(initialPageState);
      await loadKnowledgeBases({ pageState: initialPageState });
    } else {
      setKnowledgeBases((current) => [result.knowledgeBase, ...current]);
    }
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
    setKnowledgeBases((current) =>
      current.map((item) => item.id === result.knowledgeBase.id ? result.knowledgeBase : item)
    );
    setSelectedKnowledgeBase((current) =>
      current?.id === result.knowledgeBase.id ? result.knowledgeBase : current
    );
    return { knowledgeBase: result.knowledgeBase };
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

  if (isSettingsOpen) {
    return (
      <AdminPageBoundary>
        <SettingsPage
          onBack={returnHome}
          onLogout={() => void handleLogout()}
        />
      </AdminPageBoundary>
    );
  }

  return (
    <AdminPageBoundary>
      <AdminHomePage
        knowledgeBases={knowledgeBases}
        knowledgeBaseQuery={knowledgeBaseQuery}
        knowledgeBasePageNumber={knowledgeBasePageState.pageNumber}
        hasPreviousKnowledgeBasePage={knowledgeBasePageState.previousCursors.length > 0}
        hasNextKnowledgeBasePage={Boolean(knowledgeBasePageState.nextCursor)}
        isLoading={isLoadingKnowledgeBases}
        publicOpenApiKeys={publicOpenApiKeys}
        publicOpenApiKeysNextCursor={publicOpenApiKeysNextCursor}
        publicOpenApiKeysOneTimeKey={publicOpenApiKeysOneTimeKey}
        isLoadingPublicOpenApiKeys={isLoadingPublicOpenApiKeys}
        onCreate={handleCreateKnowledgeBase}
        onUpdate={handleUpdateKnowledgeBase}
        onDelete={handleDeleteKnowledgeBase}
        onCreatePublicOpenApiKey={handleCreatePublicOpenApiKey}
        onDeletePublicOpenApiKey={handleDeletePublicOpenApiKey}
        onDismissPublicOpenApiOneTimeKey={() => setPublicOpenApiKeysOneTimeKey(null)}
        onLoadPublicOpenApiKeys={(input) => void loadPublicOpenApiKeys(input)}
        onOpenApiKeysTabSelected={handleOpenApiKeysTabSelected}
        onPreviousKnowledgeBasePage={() => void handleKnowledgeBasePreviousPage()}
        onNextKnowledgeBasePage={() => void handleKnowledgeBaseNextPage()}
        onSearchKnowledgeBases={(query) => void handleKnowledgeBaseQueryChange(query)}
        onLogout={() => void handleLogout()}
        onOpenSettings={openSettings}
        onOpenKnowledgeBase={openKnowledgeBase}
      />
    </AdminPageBoundary>
  );
}
