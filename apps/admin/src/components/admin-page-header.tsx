import type { ReactNode } from "react";

type AdminPageHeaderProps = {
  start: ReactNode;
  end?: ReactNode;
};

export function AdminPageHeader({ start, end }: AdminPageHeaderProps) {
  return (
    <header data-slot="admin-page-header" className="h-14 shrink-0 border-b bg-card">
      <div className="flex h-full items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2">{start}</div>
        {end ? <div className="flex shrink-0 items-center gap-2">{end}</div> : null}
      </div>
    </header>
  );
}
