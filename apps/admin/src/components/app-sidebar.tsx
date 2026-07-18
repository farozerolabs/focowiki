import type * as React from "react";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  FolderInputIcon,
  FilePenLineIcon,
  ListChecksIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PencilIcon,
  LoaderCircleIcon,
  SearchIcon,
  XIcon,
  Trash2Icon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DropdownMenuSeparator,
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
  sourceDirectoryId: string | null;
  sourceFileId: string | null;
  resourceRevision: number | null;
  descendantFileCount: number;
};

export type AdminSidebarSourceFile = {
  id: string;
  state: "queued" | "running" | "pending_publication" | "visible" | "failed";
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
    deleteDirectory: string;
    fileActions: string;
    directoryActions: string;
    rename: string;
    move: string;
    replaceContent: string;
    emptyFiles: string;
    loadingFiles: string;
    fileTreeSearchPlaceholder: string;
    clearFileTreeSearch: string;
    fileTreeSearchNoResults: string;
    fileTreeSearchLoadMore: string;
  };
  activeView: "file" | "processing";
  tree: AdminSidebarTreeNode[];
  rootNextCursor: string | null;
  rootLoading: boolean;
  sourceFiles: AdminSidebarSourceFile[];
  onBack: () => void;
  onLogout: () => void;
  onOpenProcessing: () => void;
  onOpenFile: (node: AdminSidebarTreeNode) => void;
  onDeleteFile: (node: AdminSidebarTreeNode) => void;
  onDeleteDirectory: (node: AdminSidebarTreeNode) => void;
  onEditResource: (action: "rename" | "move" | "replace", node: AdminSidebarTreeNode) => void;
  isResourceBusy: (node: AdminSidebarTreeNode) => boolean;
  onToggleDirectory: (node: AdminSidebarTreeNode, open: boolean) => void;
  onLoadMoreTree: (parentPath: string) => void;
  fileTreeSearch: {
    query: string;
    isActive: boolean;
    isLoading: boolean;
    nextCursor: string | null;
    statusMessage: string | null;
    onQueryChange: (query: string) => void;
    onClear: () => void;
    onLoadMore: () => void;
  };
  resizeRail?: {
    label: string;
    width: number;
    minWidth: number;
    maxWidth: number;
    onWidthChange: (width: number) => void;
  };
};

export function AppSidebar({
  appName,
  knowledgeBaseName,
  labels,
  activeView,
  tree,
  rootNextCursor,
  rootLoading,
  sourceFiles,
  onBack,
  onLogout,
  onOpenProcessing,
  onOpenFile,
  onDeleteFile,
  onDeleteDirectory,
  onEditResource,
  isResourceBusy,
  onToggleDirectory,
  onLoadMoreTree,
  fileTreeSearch,
  resizeRail,
  ...props
}: AppSidebarProps) {
  const runningSourceFiles = sourceFiles.filter(
    (file) => file.state === "queued" || file.state === "running"
  ).length;

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 pt-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={labels.back} onClick={onBack}>
            <ArrowLeftIcon />
          </Button>
          <img src="/logo.svg" alt="" className="size-7 object-contain" />
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
                <SidebarMenuButton isActive={activeView === "processing"} onClick={onOpenProcessing}>
                  <ListChecksIcon />
                  <span>{labels.uploadProgress}</span>
                </SidebarMenuButton>
                {sourceFiles.length > 0 ? (
                  <SidebarMenuBadge>{runningSourceFiles > 0 ? labels.running : labels.ended}</SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>{labels.files}</SidebarGroupLabel>
          <SidebarGroupContent>
            <div className="relative px-2 pb-2">
              <SearchIcon className="pointer-events-none absolute top-1.5 left-4 size-4 text-sidebar-foreground/50" />
              <Input
                value={fileTreeSearch.query}
                onChange={(event) => fileTreeSearch.onQueryChange(event.target.value)}
                placeholder={labels.fileTreeSearchPlaceholder}
                className="h-8 pr-8 pl-8 text-xs"
              />
              {fileTreeSearch.query ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={labels.clearFileTreeSearch}
                  className="absolute top-1 right-3"
                  onClick={fileTreeSearch.onClear}
                >
                  <XIcon />
                </Button>
              ) : null}
            </div>
            <SidebarMenu>
              {tree.length === 0 ? (
                <SidebarMenuItem>
                  <p className="px-2 py-2 text-xs text-sidebar-foreground/60">
                    {fileTreeSearch.statusMessage ??
                      (fileTreeSearch.isLoading || (!fileTreeSearch.isActive && rootLoading)
                        ? labels.loadingFiles
                        : fileTreeSearch.isActive
                          ? labels.fileTreeSearchNoResults
                          : labels.emptyFiles)}
                  </p>
                </SidebarMenuItem>
              ) : null}
              {tree.map((node) => (
                <TreeNode
                  key={node.id}
                  labels={labels}
                  node={node}
                  onOpenFile={onOpenFile}
                  onDeleteFile={onDeleteFile}
                  onDeleteDirectory={onDeleteDirectory}
                  onEditResource={onEditResource}
                  isResourceBusy={isResourceBusy}
                  onToggleDirectory={onToggleDirectory}
                  onLoadMoreTree={onLoadMoreTree}
                  isSearchMode={fileTreeSearch.isActive}
                />
              ))}
              {fileTreeSearch.isActive && fileTreeSearch.nextCursor ? (
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={fileTreeSearch.onLoadMore}>
                    <span>{labels.fileTreeSearchLoadMore}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
              {!fileTreeSearch.isActive && rootNextCursor ? (
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
      {resizeRail ? <SidebarRail resize={resizeRail} /> : <SidebarRail />}
    </Sidebar>
  );
}

function TreeNode({
  labels,
  node,
  onOpenFile,
  onDeleteFile,
  onDeleteDirectory,
  onEditResource,
  isResourceBusy,
  onToggleDirectory,
  onLoadMoreTree,
  isSearchMode
}: {
  labels: AppSidebarProps["labels"];
  node: AdminSidebarTreeNode;
  onOpenFile: (node: AdminSidebarTreeNode) => void;
  onDeleteFile: (node: AdminSidebarTreeNode) => void;
  onDeleteDirectory: (node: AdminSidebarTreeNode) => void;
  onEditResource: AppSidebarProps["onEditResource"];
  isResourceBusy: AppSidebarProps["isResourceBusy"];
  onToggleDirectory: (node: AdminSidebarTreeNode, open: boolean) => void;
  onLoadMoreTree: (parentPath: string) => void;
  isSearchMode: boolean;
}) {
  if (node.entryType === "file") {
    return (
      <SidebarMenuItem>
        <div className="flex min-w-0 items-center gap-1">
          <SidebarMenuButton
            isActive={node.isActive}
            className="min-w-0 flex-1"
            onClick={() => onOpenFile(node)}
          >
            <FileTextIcon />
            <span className="min-w-0 flex-1 truncate" title={node.name}>
              {node.name}
            </span>
          </SidebarMenuButton>
          {node.deletable && node.sourceFileId ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${labels.fileActions}: ${node.name}`}
                  disabled={isResourceBusy(node)}
                >
                  {isResourceBusy(node) ? <LoaderCircleIcon className="animate-spin" /> : <MoreHorizontalIcon />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => onEditResource("rename", node)}>
                    <PencilIcon />
                    {labels.rename}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onEditResource("move", node)}>
                    <FolderInputIcon />
                    {labels.move}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onEditResource("replace", node)}>
                    <FilePenLineIcon />
                    {labels.replaceContent}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
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
        open={isSearchMode ? true : node.isExpanded}
        onOpenChange={(open) => {
          if (!isSearchMode) {
            onToggleDirectory(node, open);
          }
        }}
        className="group/collapsible [&[data-state=open]>button>svg:first-child]:rotate-90"
      >
        <div className="flex min-w-0 items-center gap-1">
          <CollapsibleTrigger asChild>
            <SidebarMenuButton className="min-w-0 flex-1">
              <ChevronRightIcon className="transition-transform" />
              <FolderIcon />
              <span className="min-w-0 flex-1 truncate" title={node.name}>
                {node.name}
              </span>
            </SidebarMenuButton>
          </CollapsibleTrigger>
          {node.deletable && node.sourceDirectoryId && node.resourceRevision ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${labels.directoryActions}: ${node.name}`}
                  disabled={isResourceBusy(node)}
                >
                  {isResourceBusy(node) ? <LoaderCircleIcon className="animate-spin" /> : <MoreHorizontalIcon />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => onEditResource("rename", node)}>
                    <PencilIcon />
                    {labels.rename}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onEditResource("move", node)}>
                    <FolderInputIcon />
                    {labels.move}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => onDeleteDirectory(node)}
                  >
                    <Trash2Icon />
                    {labels.deleteDirectory}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <CollapsibleContent>
          <SidebarMenuSub>
            {node.children.map((child) => (
              <TreeNode
                key={child.id}
                labels={labels}
                node={child}
                onOpenFile={onOpenFile}
                onDeleteFile={onDeleteFile}
                onDeleteDirectory={onDeleteDirectory}
                onEditResource={onEditResource}
                isResourceBusy={isResourceBusy}
                onToggleDirectory={onToggleDirectory}
                onLoadMoreTree={onLoadMoreTree}
                isSearchMode={isSearchMode}
              />
            ))}
            {!isSearchMode && node.nextCursor ? (
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
