import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { SourceFileErrorFilterHeader } from
  "../src/components/source-file-filter-controls";
import { initI18n } from "../src/i18n";
import {
  createEmptySourceFileListFilters,
  type SourceFileListFilters
} from "../src/lib/source-file-list-filters";

beforeAll(async () => {
  await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));
});

describe("source file filter controls", () => {
  it("clears the error code and error state in one update", async () => {
    render(<ErrorFilterHarness />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter Error" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Clear" }));

    expect(screen.getByTestId("error-filter-value").textContent).toBe("|none");
    expect(screen.getByRole("button", { name: "Filter Error" })
      .getAttribute("aria-pressed")).toBe("false");
  });
});

function ErrorFilterHarness() {
  const [filters, setFilters] = useState<SourceFileListFilters>({
    ...createEmptySourceFileListFilters(),
    errorCodeQuery: "NON_EXISTENT",
    errorState: "without_error"
  });

  return (
    <>
      <SourceFileErrorFilterHeader
        filters={filters}
        onFiltersChange={setFilters}
      />
      <output data-testid="error-filter-value">
        {filters.errorCodeQuery}|{filters.errorState ?? "none"}
      </output>
    </>
  );
}
