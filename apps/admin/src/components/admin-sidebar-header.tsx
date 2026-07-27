import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarHeader } from "@/components/ui/sidebar";

type AdminSidebarHeaderProps = {
  appName: string;
  contextName?: string;
  backLabel?: string;
  onBack?: () => void;
};

export function AdminSidebarHeader({
  appName,
  contextName,
  backLabel,
  onBack
}: AdminSidebarHeaderProps) {
  return (
    <SidebarHeader className="h-14 shrink-0 justify-center border-b">
      <div className="flex min-w-0 items-center gap-2 px-2">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={backLabel}
            onClick={onBack}
          >
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <img src="/logo.svg" alt="" className="size-7 object-contain" />
        {contextName ? (
          <div className="min-w-0">
            <p className="truncate text-xs text-sidebar-foreground/70">{appName}</p>
            <p className="truncate text-sm font-medium">{contextName}</p>
          </div>
        ) : (
          <h1 className="truncate text-sm font-medium">{appName}</h1>
        )}
      </div>
    </SidebarHeader>
  );
}
