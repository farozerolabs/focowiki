import * as React from "react"

import { cn } from "@/lib/utils"

function Pagination({
  className,
  "aria-label": ariaLabel = "pagination",
  ...props
}: React.ComponentProps<"nav">) {
  return (
    <nav
      aria-label={ariaLabel}
      data-slot="pagination"
      className={cn("flex w-full justify-center", className)}
      {...props}
    />
  )
}

function PaginationContent({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn("flex flex-row items-center gap-1", className)}
      {...props}
    />
  )
}

function PaginationItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="pagination-item" className={cn(className)} {...props} />
}

export { Pagination, PaginationContent, PaginationItem }
