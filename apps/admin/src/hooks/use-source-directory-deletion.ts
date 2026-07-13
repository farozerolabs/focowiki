import { useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { AdminSidebarTreeNode } from "@/components/app-sidebar";
import { showAdminToast } from "@/hooks/use-admin-toast";
import { deleteKnowledgeBaseSourceDirectory } from "@/lib/admin-api";
import type { TreePageState } from "@/lib/sidebar-tree";

export function useSourceDirectoryDeletion(input: {
  knowledgeBaseId: string;
  selectedFilePath: string;
  setTreePages: Dispatch<SetStateAction<Record<string, TreePageState>>>;
  setExpandedDirectories: Dispatch<SetStateAction<Set<string>>>;
  clearSelectedFile: () => void;
  refreshProcessingSummary: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<AdminSidebarTreeNode | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const deleteTarget = async () => {
    if (!target?.sourceDirectoryId || !target.resourceRevision) return;
    const current = target;
    const sourceDirectoryId = target.sourceDirectoryId;
    const expectedResourceRevision = target.resourceRevision;
    setTarget(null);
    setIsDeleting(true);
    const result = await deleteKnowledgeBaseSourceDirectory({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceDirectoryId,
      expectedResourceRevision
    });
    setIsDeleting(false);
    if ("messageKey" in result) {
      showAdminToast({ variant: "destructive", title: t("errors.deleteDirectoryFailed") });
      return;
    }
    input.setTreePages((pages) => hideDeletedTreeBranch(pages, current.logicalPath));
    input.setExpandedDirectories((paths) =>
      new Set([...paths].filter((path) => path !== current.logicalPath && !path.startsWith(`${current.logicalPath}/`)))
    );
    if (input.selectedFilePath.startsWith(`${current.logicalPath}/`)) input.clearSelectedFile();
    showAdminToast({
      title: t("delete.directoryAccepted"),
      description: t("delete.directoryAcceptedDescription", { count: result.affectedFileCount })
    });
    await input.refreshProcessingSummary();
  };

  return { target, setTarget, isDeleting, deleteTarget };
}

function hideDeletedTreeBranch(
  pages: Record<string, TreePageState>,
  deletedPath: string
): Record<string, TreePageState> {
  return Object.fromEntries(
    Object.entries(pages)
      .filter(([path]) => path !== deletedPath && !path.startsWith(`${deletedPath}/`))
      .map(([path, page]) => [
        path,
        {
          ...page,
          items: page.items.filter(
            (item) => item.logicalPath !== deletedPath && !item.logicalPath.startsWith(`${deletedPath}/`)
          )
        }
      ])
  );
}
