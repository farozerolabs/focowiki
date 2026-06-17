import type * as React from "react";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  ListChecksIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  Trash2Icon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarSeparator
} from "@/components/ui/sidebar";

export type AdminSidebarTreeNode = {
  id: string;
  name: string;
  logicalPath: string;
  entryType: "directory" | "file";
  children: AdminSidebarTreeNode[];
  isExpanded: boolean;
  isActive: boolean;
  nextCursor: string | null;
  deletable: boolean;
};

export type AdminSidebarTask = {
  id: string;
  lifecycle: "running" | "ended";
};

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  appName: string;
  knowledgeBaseName: string;
  labels: {
    back: string;
    files: string;
    uploadProgress: string;
    loadMore: string;
    logout: string;
    running: string;
    ended: string;
    deleteFile: string;
    fileActions: string;
  };
  activeView: "file" | "tasks";
  tree: AdminSidebarTreeNode[];
  rootNextCursor: string | null;
  tasks: AdminSidebarTask[];
  onBack: () => void;
  onLogout: () => void;
  onOpenTasks: () => void;
  onOpenFile: (node: AdminSidebarTreeNode) => void;
  onDeleteFile: (node: AdminSidebarTreeNode) => void;
  onToggleDirectory: (node: AdminSidebarTreeNode, open: boolean) => void;
  onLoadMoreTree: (parentPath: string) => void;
};

export function AppSidebar({
  appName,
  knowledgeBaseName,
  labels,
  activeView,
  tree,
  rootNextCursor,
  tasks,
  onBack,
  onLogout,
  onOpenTasks,
  onOpenFile,
  onDeleteFile,
  onToggleDirectory,
  onLoadMoreTree,
  ...props
}: AppSidebarProps) {
  const runningTasks = tasks.filter((task) => task.lifecycle === "running").length;

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 pt-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={labels.back} onClick={onBack}>
            <ArrowLeftIcon />
          </Button>
          <img src="/logo.jpg" alt="" className="size-7 rounded object-cover" />
          <div className="min-w-0">
            <p className="truncate text-xs text-sidebar-foreground/70">{appName}</p>
            <p className="truncate text-sm font-medium">{knowledgeBaseName}</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{labels.uploadProgress}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={activeView === "tasks"} onClick={onOpenTasks}>
                  <ListChecksIcon />
                  <span>{labels.uploadProgress}</span>
                </SidebarMenuButton>
                {tasks.length > 0 ? (
                  <SidebarMenuBadge>{runningTasks > 0 ? labels.running : labels.ended}</SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>{labels.files}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {tree.map((node) => (
                <TreeNode
                  key={node.id}
                  labels={labels}
                  node={node}
                  onOpenFile={onOpenFile}
                  onDeleteFile={onDeleteFile}
                  onToggleDirectory={onToggleDirectory}
                  onLoadMoreTree={onLoadMoreTree}
                />
              ))}
              {rootNextCursor ? (
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={() => onLoadMoreTree("")}>
                    <span>{labels.loadMore}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <Button type="button" variant="ghost" className="w-full justify-start" onClick={onLogout}>
          <LogOutIcon data-icon="inline-start" />
          {labels.logout}
        </Button>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function TreeNode({
  labels,
  node,
  onOpenFile,
  onDeleteFile,
  onToggleDirectory,
  onLoadMoreTree
}: {
  labels: AppSidebarProps["labels"];
  node: AdminSidebarTreeNode;
  onOpenFile: (node: AdminSidebarTreeNode) => void;
  onDeleteFile: (node: AdminSidebarTreeNode) => void;
  onToggleDirectory: (node: AdminSidebarTreeNode, open: boolean) => void;
  onLoadMoreTree: (parentPath: string) => void;
}) {
  if (node.entryType === "file") {
    return (
      <SidebarMenuItem>
        <div className="flex items-center gap-1">
          <SidebarMenuButton isActive={node.isActive} onClick={() => onOpenFile(node)}>
            <FileTextIcon />
            <span>{node.name}</span>
          </SidebarMenuButton>
          {node.deletable ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${labels.fileActions}: ${node.name}`}
                >
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      onDeleteFile(node);
                    }}
                  >
                    <Trash2Icon />
                    {labels.deleteFile}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <Collapsible
        open={node.isExpanded}
        onOpenChange={(open) => onToggleDirectory(node, open)}
        className="group/collapsible [&[data-state=open]>button>svg:first-child]:rotate-90"
      >
        <CollapsibleTrigger asChild>
          <SidebarMenuButton>
            <ChevronRightIcon className="transition-transform" />
            <FolderIcon />
            <span>{node.name}</span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {node.children.map((child) => (
              <TreeNode
                key={child.id}
                labels={labels}
                node={child}
                onOpenFile={onOpenFile}
                onDeleteFile={onDeleteFile}
                onToggleDirectory={onToggleDirectory}
                onLoadMoreTree={onLoadMoreTree}
              />
            ))}
            {node.nextCursor ? (
              <SidebarMenuSubItem>
                <SidebarMenuSubButton asChild>
                  <button type="button" onClick={() => onLoadMoreTree(node.logicalPath)}>
                    <span>{labels.loadMore}</span>
                  </button>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ) : null}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}
