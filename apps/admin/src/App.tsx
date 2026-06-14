import { useEffect, useState } from "react";
import { AdminHomePage } from "@/pages/AdminHomePage";
import { KnowledgeBaseDetailPage } from "@/pages/KnowledgeBaseDetailPage";
import { LoginPage } from "@/pages/LoginPage";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  checkAdminSession,
  createKnowledgeBase,
  listKnowledgeBases,
  logoutAdmin,
  type ApiFailure,
  type KnowledgeBase
} from "@/lib/admin-api";

type AuthState = "checking" | "anonymous" | "authenticated";

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingKnowledgeBases, setIsLoadingKnowledgeBases] = useState(false);
  const [selectedKnowledgeBase, setSelectedKnowledgeBase] = useState<KnowledgeBase | null>(null);

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
    setKnowledgeBases([]);
    setNextCursor(null);
    setSelectedKnowledgeBase(null);
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
        onCreate={handleCreateKnowledgeBase}
        onLoadMore={() => void loadKnowledgeBases({ replace: false })}
        onLogout={() => void handleLogout()}
        onOpenKnowledgeBase={setSelectedKnowledgeBase}
      />
    </TooltipProvider>
  );
}
