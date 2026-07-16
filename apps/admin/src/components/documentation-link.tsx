import { useTranslation } from "react-i18next";
import { BookOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function DocumentationLink() {
  const { t } = useTranslation();
  const label = t("documentation.open");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" size="icon-sm">
          <a
            href="https://docs.focowiki.com"
            target="_blank"
            rel="noreferrer"
            aria-label={label}
          >
            <BookOpenIcon />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
