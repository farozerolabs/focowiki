import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ListFilterIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  fromDatetimeLocalValue,
  SOURCE_FILE_ACTION_STATES,
  SOURCE_FILE_ERROR_STATES,
  SOURCE_FILE_GENERATED_OUTPUT_STATUSES,
  SOURCE_FILE_MODEL_INVOCATION_STATUSES,
  SOURCE_FILE_CURRENT_STAGES,
  SOURCE_FILE_LIFECYCLE_STATES,
  sourceFileFilterCount,
  toDatetimeLocalValue,
  type SourceFileActionState,
  type SourceFileErrorState,
  type SourceFileGeneratedOutputStatus,
  type SourceFileListFilters,
  type SourceFileModelInvocationStatus,
  type SourceFileCurrentStage,
  type SourceFileLifecycleState
} from "@/lib/source-file-list-filters";

type SourceFileFilterControlsProps = {
  filters: SourceFileListFilters;
  onFiltersChange: (filters: SourceFileListFilters) => void;
  onClearAll: () => void;
};

type TextFilterHeaderProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
};

type EnumFilterHeaderProps<T extends string> = {
  label: string;
  value: T | null;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T | null) => void;
};

type TimeRangeFilterHeaderProps = {
  label: string;
  from: string | null;
  to: string | null;
  onChange: (range: { from: string | null; to: string | null }) => void;
};

const ALL_VALUE = "__all";

export function SourceFileActiveFilterSummary({
  filters,
  onClearAll
}: Pick<SourceFileFilterControlsProps, "filters" | "onClearAll">) {
  const { t } = useTranslation();
  const activeCount = sourceFileFilterCount(filters);

  if (activeCount === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 p-2 text-sm">
      <span className="text-muted-foreground">
        {t("tasks.filters.activeCount", { count: activeCount })}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onClearAll}>
        <XIcon data-icon="inline-start" />
        {t("tasks.filters.clearAll")}
      </Button>
    </div>
  );
}

export function SourceFileStatusFilterHeader({
  filters,
  onFiltersChange
}: Pick<SourceFileFilterControlsProps, "filters" | "onFiltersChange">) {
  const { t } = useTranslation();

  return (
    <EnumFilterHeader<SourceFileLifecycleState>
      label={t("tasks.filesTable.status")}
      value={filters.state}
      options={SOURCE_FILE_LIFECYCLE_STATES.map((status) => ({
        value: status,
        label: t(`tasks.fileStatus.${status}`)
      }))}
      onChange={(state) => onFiltersChange({ ...filters, state })}
    />
  );
}

export function SourceFileNameFilterHeader({
  filters,
  onFiltersChange
}: Pick<SourceFileFilterControlsProps, "filters" | "onFiltersChange">) {
  const { t } = useTranslation();

  return (
    <TextFilterHeader
      label={t("tasks.filesTable.fileName")}
      value={filters.fileNameQuery}
      onChange={(fileNameQuery) => onFiltersChange({ ...filters, fileNameQuery })}
    />
  );
}

export function SourceFileIdFilterHeader({
  filters,
  onFiltersChange
}: Pick<SourceFileFilterControlsProps, "filters" | "onFiltersChange">) {
  const { t } = useTranslation();

  return (
    <TextFilterHeader
      label={t("tasks.filesTable.fileId")}
      value={filters.fileIdQuery}
      onChange={(fileIdQuery) => onFiltersChange({ ...filters, fileIdQuery })}
    />
  );
}

export function SourceFileStageFilterHeader({
  filters,
  onFiltersChange
}: Pick<SourceFileFilterControlsProps, "filters" | "onFiltersChange">) {
  const { t } = useTranslation();

  return (
    <EnumFilterHeader<SourceFileCurrentStage>
      label={t("tasks.filesTable.stage")}
      value={filters.currentStage}
      options={SOURCE_FILE_CURRENT_STAGES.map((stage) => ({
        value: stage,
        label: t(`tasks.phase.${toCamelCase(stage)}`)
      }))}
      onChange={(currentStage) => onFiltersChange({ ...filters, currentStage })}
    />
  );
}

export function SourceFileModelFilterHeader({
  filters,
  onFiltersChange
}: Pick<SourceFileFilterControlsProps, "filters" | "onFiltersChange">) {
  const { t } = useTranslation();

  return (
    <EnumFilterHeader<SourceFileModelInvocationStatus>
      label={t("tasks.filesTable.model")}
      value={filters.modelInvocationStatus}
      options={SOURCE_FILE_MODEL_INVOCATION_STATUSES.map((status) => ({
        value: status,
        label: status === "not_recorded" ? t("tasks.notRecorded") : t(`tasks.modelStatus.${status}`)
      }))}
      onChange={(modelInvocationStatus) => onFiltersChange({ ...filters, modelInvocationStatus })}
    />
  );
}

export function SourceFileGeneratedFilterHeader({
  filters,
  onFiltersChange
}: Pick<SourceFileFilterControlsProps, "filters" | "onFiltersChange">) {
  const { t } = useTranslation();

  return (
    <EnumFilterHeader<SourceFileGeneratedOutputStatus>
      label={t("tasks.filesTable.generatedFile")}
      value={filters.generatedOutputStatus}
      options={SOURCE_FILE_GENERATED_OUTPUT_STATUSES.map((status) => ({
        value: status,
        label: t(`tasks.generatedFile.${generatedStatusKey(status)}`)
      }))}
      onChange={(generatedOutputStatus) =>
        onFiltersChange({ ...filters, generatedOutputStatus })
      }
    />
  );
}

export function SourceFileStartedFilterHeader({
  filters,
  onFiltersChange
}: Pick<SourceFileFilterControlsProps, "filters" | "onFiltersChange">) {
  const { t } = useTranslation();

  return (
    <TimeRangeFilterHeader
      label={t("tasks.filesTable.startedAt")}
      from={filters.startedFrom}
      to={filters.startedTo}
      onChange={(range) =>
        onFiltersChange({ ...filters, startedFrom: range.from, startedTo: range.to })
      }
    />
  );
}

export function SourceFileEndedFilterHeader({
  filters,
  onFiltersChange
}: Pick<SourceFileFilterControlsProps, "filters" | "onFiltersChange">) {
  const { t } = useTranslation();

  return (
    <TimeRangeFilterHeader
      label={t("tasks.filesTable.endedAt")}
      from={filters.endedFrom}
      to={filters.endedTo}
      onChange={(range) =>
        onFiltersChange({ ...filters, endedFrom: range.from, endedTo: range.to })
      }
    />
  );
}

export function SourceFileErrorFilterHeader({
  filters,
  onFiltersChange
}: Pick<SourceFileFilterControlsProps, "filters" | "onFiltersChange">) {
  const { t } = useTranslation();

  return (
    <TextAndEnumFilterHeader<SourceFileErrorState>
      label={t("tasks.filesTable.error")}
      textValue={filters.errorCodeQuery}
      enumValue={filters.errorState}
      options={SOURCE_FILE_ERROR_STATES.map((state) => ({
        value: state,
        label: t(`tasks.filters.errorState.${state}`)
      }))}
      onTextChange={(errorCodeQuery) => onFiltersChange({ ...filters, errorCodeQuery })}
      onEnumChange={(errorState) => onFiltersChange({ ...filters, errorState })}
    />
  );
}

export function SourceFileActionFilterHeader({
  filters,
  onFiltersChange
}: Pick<SourceFileFilterControlsProps, "filters" | "onFiltersChange">) {
  const { t } = useTranslation();

  return (
    <EnumFilterHeader<SourceFileActionState>
      label={t("tasks.filesTable.actions")}
      value={filters.actionState}
      options={SOURCE_FILE_ACTION_STATES.map((state) => ({
        value: state,
        label: t(`tasks.filters.actionState.${state}`)
      }))}
      onChange={(actionState) => onFiltersChange({ ...filters, actionState })}
    />
  );
}

function TextFilterHeader({ label, value, onChange }: TextFilterHeaderProps) {
  const { t } = useTranslation();

  return (
    <FilterHeader label={label} active={Boolean(value.trim())}>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <div className="p-1">
        <Input
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!value.trim()} onSelect={() => onChange("")}>
        {t("tasks.filters.clear")}
      </DropdownMenuItem>
    </FilterHeader>
  );
}

function TextAndEnumFilterHeader<T extends string>({
  label,
  textValue,
  enumValue,
  options,
  onTextChange,
  onEnumChange
}: {
  label: string;
  textValue: string;
  enumValue: T | null;
  options: Array<{ value: T; label: string }>;
  onTextChange: (value: string) => void;
  onEnumChange: (value: T | null) => void;
}) {
  const { t } = useTranslation();

  return (
    <FilterHeader label={label} active={Boolean(textValue.trim()) || Boolean(enumValue)}>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <div className="p-1">
        <Input
          aria-label={t("tasks.filters.errorCode")}
          value={textValue}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup
        value={enumValue ?? ALL_VALUE}
        onValueChange={(value) => onEnumChange(value === ALL_VALUE ? null : (value as T))}
      >
        <DropdownMenuRadioItem value={ALL_VALUE}>{t("tasks.filters.all")}</DropdownMenuRadioItem>
        {options.map((option) => (
          <DropdownMenuRadioItem key={option.value} value={option.value}>
            {option.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={!textValue.trim() && !enumValue}
        onSelect={() => {
          onTextChange("");
          onEnumChange(null);
        }}
      >
        {t("tasks.filters.clear")}
      </DropdownMenuItem>
    </FilterHeader>
  );
}

function EnumFilterHeader<T extends string>({
  label,
  value,
  options,
  onChange
}: EnumFilterHeaderProps<T>) {
  const { t } = useTranslation();

  return (
    <FilterHeader label={label} active={Boolean(value)}>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={value ?? ALL_VALUE}
        onValueChange={(nextValue) =>
          onChange(nextValue === ALL_VALUE ? null : (nextValue as T))
        }
      >
        <DropdownMenuRadioItem value={ALL_VALUE}>{t("tasks.filters.all")}</DropdownMenuRadioItem>
        {options.map((option) => (
          <DropdownMenuRadioItem key={option.value} value={option.value}>
            {option.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </FilterHeader>
  );
}

function TimeRangeFilterHeader({ label, from, to, onChange }: TimeRangeFilterHeaderProps) {
  const { t } = useTranslation();

  return (
    <FilterHeader label={label} active={Boolean(from || to)}>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <div className="grid gap-2 p-1">
        <label className="grid gap-1 text-xs text-muted-foreground">
          <span>{t("tasks.filters.from")}</span>
          <Input
            type="datetime-local"
            value={toDatetimeLocalValue(from)}
            onChange={(event) =>
              onChange({ from: fromDatetimeLocalValue(event.target.value), to })
            }
            onKeyDown={(event) => event.stopPropagation()}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          <span>{t("tasks.filters.to")}</span>
          <Input
            type="datetime-local"
            value={toDatetimeLocalValue(to)}
            onChange={(event) =>
              onChange({ from, to: fromDatetimeLocalValue(event.target.value) })
            }
            onKeyDown={(event) => event.stopPropagation()}
          />
        </label>
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!from && !to} onSelect={() => onChange({ from: null, to: null })}>
        {t("tasks.filters.clear")}
      </DropdownMenuItem>
    </FilterHeader>
  );
}

function FilterHeader({
  label,
  active,
  children
}: {
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex min-w-0 items-center justify-between gap-1">
      <span className="min-w-0 truncate">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "size-7 shrink-0",
              active
                ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                : "text-muted-foreground"
            )}
            aria-label={t("tasks.filters.filterColumn", { column: label })}
            aria-pressed={active}
          >
            <ListFilterIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64">{children}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function generatedStatusKey(value: SourceFileGeneratedOutputStatus): string {
  return value === "visible" ? "available" : value;
}
