import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

type CursorPaginationControlsProps = {
  labels: {
    currentPage: string;
    next: string;
    previous: string;
  };
  hasNext: boolean;
  hasPrevious: boolean;
  isLoading?: boolean;
  onNext: () => void;
  onPrevious: () => void;
};

export function CursorPaginationControls({
  labels,
  hasNext,
  hasPrevious,
  isLoading = false,
  onNext,
  onPrevious
}: CursorPaginationControlsProps) {
  return (
    <nav
      aria-label={labels.currentPage}
      className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm text-muted-foreground">{labels.currentPage}</p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!hasPrevious || isLoading}
          onClick={onPrevious}
        >
          <ChevronLeftIcon data-icon="inline-start" />
          {labels.previous}
        </Button>
        <Button type="button" variant="outline" disabled={!hasNext || isLoading} onClick={onNext}>
          {labels.next}
          <ChevronRightIcon data-icon="inline-end" />
        </Button>
      </div>
    </nav>
  );
}
